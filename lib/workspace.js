/**
 * Workspace snapshot engine for dsh-plugin-rewind.
 *
 * The engine walks a workspace directory and produces a *manifest*: one entry
 * per regular file (content hash + size + mtime + mode), one per symlink, and
 * the directory list. File bytes live in a content-addressed blob store, so a
 * file that does not change between checkpoints is stored exactly once.
 *
 * It deliberately uses `node:fs` rather than the host `ctx.fs` service:
 *  - `ctx.fs` exposes no delete, mkdir, move or hash primitive, and a rollback
 *    needs all of them;
 *  - `ctx.fs` writes are fenced by the deployment sandbox, which would make a
 *    rollback fail under `workspace-write` whenever the workspace root and the
 *    sandbox root disagree.
 * Both are documented trade-offs of this plugin (see README).
 *
 * @module dsh-plugin-rewind/workspace
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Manifest format version written by this module. */
export const MANIFEST_VERSION = 1

/**
 * Directory names never walked, and never restored or deleted.
 * The VCS set matches the prune list `dsh-tool-fs-search` already uses, so the
 * rollback scope agrees with the product's own notion of project content.
 */
export const DEFAULT_EXCLUDE_DIRS = [
  '.git', '.hg', '.svn', '.bzr', '.jj', '.sl',
  'node_modules', 'bower_components',
  '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.venv', 'venv', '.gradle', '.idea', '.vs',
]

/** File-name suffixes never snapshotted: build output and large binaries. */
export const DEFAULT_EXCLUDE_SUFFIXES = [
  '.log', '.tmp', '.zst', '.asar', '.zip', '.gz', '.7z', '.rar',
  '.mp4', '.mov', '.avi', '.mkv', '.iso', '.exe', '.dll', '.so', '.dylib',
]

/** Per-file blob cap. Larger files are recorded but marked unrestorable. */
export const DEFAULT_MAX_BLOB_BYTES = 8 * 1024 * 1024

/** Total blob budget for one snapshot; the walk stops once it is exceeded. */
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** Total file-count budget for one snapshot. */
export const DEFAULT_MAX_FILES = 40000

/** Convert an OS path to the manifest's forward-slash relative form. */
export function toRelPosix(from, to) {
  return relative(from, to).split(sep).join('/')
}

/** Convert a manifest-relative path back to a native absolute path. */
export function fromRelPosix(root, rel) {
  return join(root, ...String(rel).split('/'))
}

/** sha256 of one buffer, as lowercase hex. */
export function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Build the exclusion predicate for one walk.
 * @param options - optional extra directory names and file suffixes.
 * @returns a predicate over a manifest-relative path.
 */
export function createExcludeMatcher(options = {}) {
  const dirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(options.excludeDirs ?? [])])
  const suffixes = [...DEFAULT_EXCLUDE_SUFFIXES, ...(options.excludeSuffixes ?? [])]
  const extra = options.excludeNames ?? []
  return (rel) => {
    if (rel === '') return false
    const segments = rel.split('/')
    for (const segment of segments.slice(0, -1)) {
      if (dirs.has(segment)) return true
    }
    const name = segments[segments.length - 1]
    if (dirs.has(name)) return true
    if (extra.includes(name)) return true
    const lower = name.toLowerCase()
    return suffixes.some((suffix) => lower.endsWith(suffix))
  }
}

/** Yield `[relPosix, dirent]` for every child of `dir`, in stable name order. */
async function readChildren(root, dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { entries: [], error }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    entries: entries.map((entry) => [toRelPosix(root, join(dir, entry.name)), entry]),
    error: undefined,
  }
}

/**
 * Read a file's hash, reusing the previous manifest's hash when size and mtime
 * are unchanged. That is the whole reason repeated snapshots are affordable:
 * an untouched file costs one `lstat`, not one read plus one hash.
 */
async function hashCodecFile(absPath, rel, previous) {
  const prior = previous?.get(rel)
  let stat
  try {
    stat = await fs.lstat(absPath)
  } catch (error) {
    return { error }
  }
  if (prior !== undefined
    && prior.size === stat.size
    && prior.mtimeMs === stat.mtimeMs
    && typeof prior.sha256 === 'string') {
    return { entry: { ...prior, mtimeMs: stat.mtimeMs }, reused: true }
  }
  let buffer
  try {
    buffer = await fs.readFile(absPath)
  } catch (error) {
    return { error }
  }
  return {
    entry: {
      rel,
      sha256: digest(buffer),
      size: buffer.length,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    },
    buffer,
    reused: false,
  }
}

/**
 * Walk one workspace and produce a manifest, writing new blobs through `store`.
 *
 * @param root - absolute workspace root.
 * @param options - `store` (required for blob writes), `previous` (a Map from
 *   the prior manifest's `files`, for hash reuse), exclusion, and size limits.
 * @returns the manifest plus counters describing what the walk did.
 */
export async function snapshotWorkspace(root, options = {}) {
  const store = options.store
  if (store === undefined) throw new Error('snapshotWorkspace requires a blob store')
  const excluded = createExcludeMatcher(options)
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const signal = options.signal
  const previous = options.previous ?? new Map()

  const files = []
  const symlinks = []
  const dirs = []
  const skipped = []
  let totalBytes = 0
  let hashed = 0
  let reused = 0
  let truncated = false

  const queue = ['']
  while (queue.length > 0) {
    if (signal?.aborted === true) throw new Error('snapshot aborted')
    const relDir = queue.shift()
    const absDir = relDir === '' ? root : fromRelPosix(root, relDir)
    const { entries, error } = await readChildren(root, absDir)
    if (error !== undefined) {
      skipped.push({ rel: relDir === '' ? '.' : relDir, reason: 'unreadable' })
      continue
    }
    for (const [rel, entry] of entries) {
      if (excluded(rel)) continue
      if (entry.isSymbolicLink()) {
        try {
          symlinks.push({ rel, target: await fs.readlink(join(root, ...rel.split('/'))) })
        } catch {
          skipped.push({ rel, reason: 'unreadable-symlink' })
        }
        continue
      }
      if (entry.isDirectory()) {
        dirs.push(rel)
        queue.push(rel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ rel, reason: 'not-a-regular-file' })
        continue
      }
      if (files.length >= maxFiles) {
        truncated = true
        skipped.push({ rel, reason: 'file-budget' })
        continue
      }
      const absPath = join(root, ...rel.split('/'))
      const outcome = await hashCodecFile(absPath, rel, previous)
      if (outcome.error !== undefined) {
        skipped.push({ rel, reason: 'unreadable' })
        continue
      }
      const entryRecord = outcome.entry
      if (entryRecord.size > maxBlobBytes) {
        skipped.push({ rel, reason: 'too-large', size: entryRecord.size })
        files.push({ ...entryRecord, restorable: false, reason: 'too-large' })
        continue
      }
      if (totalBytes + entryRecord.size > maxTotalBytes) {
        truncated = true
        skipped.push({ rel, reason: 'total-budget', size: entryRecord.size })
        files.push({ ...entryRecord, restorable: false, reason: 'total-budget' })
        continue
      }
      if (outcome.reused) {
        reused += 1
      } else {
        hashed += 1
        await store.putBlob(outcome.buffer, entryRecord.sha256)
        totalBytes += entryRecord.size
      }
      files.push({ ...entryRecord, restorable: true })
    }
  }

  return {
    manifest: {
      version: MANIFEST_VERSION,
      createdAt: Date.now(),
      root,
      files,
      symlinks,
      dirs,
      skipped,
      truncated,
      stats: {
        files: files.length,
        symlinks: symlinks.length,
        dirs: dirs.length,
        bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
        skipped: skipped.length,
      },
    },
    counters: { hashed, reused, truncated },
  }
}

/** Index a manifest's file list by relative path. */
export function manifestIndex(manifest) {
  return new Map((manifest?.files ?? []).map((file) => [file.rel, file]))
}

/** Index a manifest's symlink list by relative path. */
export function manifestSymlinkIndex(manifest) {
  return new Map((manifest?.symlinks ?? []).map((link) => [link.rel, link]))
}

/** Current sha256 of one workspace file, or undefined when it is absent. */
async function currentDigest(root, rel) {
  const absPath = fromRelPosix(root, rel)
  let stat
  try {
    stat = await fs.lstat(absPath)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  try {
    return digest(await fs.readFile(absPath))
  } catch {
    return undefined
  }
}

/**
 * Compare the live workspace against a checkpoint manifest without touching it.
 *
 * @param root - absolute workspace root.
 * @param manifest - the checkpoint manifest to compare against.
 * @param options - exclusion options; must match the ones used for the snapshot.
 * @returns `{ added, removed, changed, unchanged, unrestorable, unreadable }`.
 */
export async function diffWorkspace(root, manifest, options = {}) {
  const excluded = createExcludeMatcher(options)
  const wanted = manifestIndex(manifest)
  const present = new Set()
  const added = []
  const changed = []
  const unchanged = []
  const unreadable = []

  const queue = ['']
  while (queue.length > 0) {
    const relDir = queue.shift()
    const absDir = relDir === '' ? root : fromRelPosix(root, relDir)
    const { entries, error } = await readChildren(root, absDir)
    if (error !== undefined) continue
    for (const [rel, entry] of entries) {
      if (excluded(rel)) continue
      if (entry.isDirectory()) {
        queue.push(rel)
        continue
      }
      if (entry.isSymbolicLink()) {
        present.add(rel)
        const prior = wanted.get(rel)
        const target = await fs.readlink(fromRelPosix(root, rel)).catch(() => null)
        const priorLink = (manifest.symlinks ?? []).find((link) => link.rel === rel)
        if (priorLink === undefined) added.push(rel)
        else if (priorLink.target !== target) changed.push(rel)
        else unchanged.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      present.add(rel)
      const prior = wanted.get(rel)
      if (prior === undefined) {
        added.push(rel)
        continue
      }
      const stat = await fs.lstat(fromRelPosix(root, rel)).catch(() => undefined)
      if (stat !== undefined && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs) {
        unchanged.push(rel)
        continue
      }
      const live = await currentDigest(root, rel)
      if (live === undefined) unreadable.push(rel)
      else if (live === prior.sha256) unchanged.push(rel)
      else changed.push(rel)
    }
  }

  const removed = []
  for (const rel of wanted.keys()) {
    if (!present.has(rel)) removed.push(rel)
  }
  const unrestorable = (manifest.files ?? [])
    .filter((file) => file.restorable === false)
    .map((file) => ({ rel: file.rel, reason: file.reason ?? 'unknown' }))

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchanged: unchanged.length,
    unrestorable,
    unreadable,
  }
}

/** Retry a filesystem mutation a few times: on Windows editors and scanners hold locks. */
async function withRetry(operation, attempts = 4) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await new Promise((resolve_) => setTimeout(resolve_, 50 * (attempt + 1)))
    }
  }
  throw lastError
}

/** Create every directory in `dirs`, shallowest first, ignoring existing ones. */
async function ensureDirs(root, dirs, created) {
  const ordered = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)
  for (const rel of ordered) {
    const abs = fromRelPosix(root, rel)
    try {
      await fs.mkdir(abs, { recursive: true })
      created.push(rel)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
}

/** Remove the deepest directories first, so a tree can be deleted bottom-up. */
async function removeEmptyDirs(root, dirs) {
  const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)
  let removed = 0
  for (const rel of ordered) {
    const abs = fromRelPosix(root, rel)
    try {
      await fs.rmdir(abs)
      removed += 1
    } catch {
      // Not empty (it holds excluded content) or already gone: keep it.
    }
  }
  return removed
}

/** Publish one blob at `absPath` atomically, preserving the captured mode. */
async function publishBlob(absPath, buffer, mode) {
  const directory = dirname(absPath)
  await fs.mkdir(directory, { recursive: true })
  const temp = `${absPath}.rw-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await withRetry(async () => {
    await fs.writeFile(temp, buffer, mode === undefined ? undefined : { mode })
    await fs.rename(temp, absPath)
  })
  if (mode !== undefined && process.platform !== 'win32') {
    await fs.chmod(absPath, mode).catch(() => {})
  }
}

/**
 * Restore a workspace to a checkpoint manifest.
 *
 * Order is what makes one pass safe: create directories, write/replace files,
 * recreate symlinks, then delete files and directories the checkpoint did not
 * have (deepest first). Excluded paths are never written or deleted.
 *
 * @param root - absolute workspace root.
 * @param manifest - the checkpoint manifest to restore.
 * @param options - `store` (blob reader), `dryRun`, `signal`, exclusion options,
 *   and `trashDir` (when set, removed files are moved there instead of unlinked).
 * @returns a summary suitable for showing to a user or a model.
 */
export async function restoreWorkspace(root, manifest, options = {}) {
  const store = options.store
  if (store === undefined) throw new Error('restoreWorkspace requires a blob store')
  const dryRun = options.dryRun === true
  const signal = options.signal
  const excluded = createExcludeMatcher(options)
  const startedAt = Date.now()
  const failed = []
  const skippedReasons = { excluded: 0, unrestorable: 0, missingBlob: 0 }

  const plan = await diffWorkspace(root, manifest, options)

  // Unrestorable entries are reported, never silently written from a bad source.
  const wanted = manifestIndex(manifest)
  const links = manifestSymlinkIndex(manifest)
  const changedTargets = plan.changed.filter((rel) => wanted.has(rel) || links.has(rel))
  const recreatedTargets = plan.removed.filter((rel) => wanted.has(rel) || links.has(rel))

  const created = []
  const restored = []
  const recreated = []
  const removedFiles = []
  const linked = []

  if (!dryRun) {
    await ensureDirs(root, manifest.dirs ?? [], created)
  }

  for (const [rel, isRecreation] of [
    ...changedTargets.map((rel) => [rel, false]),
    ...recreatedTargets.map((rel) => [rel, true]),
  ]) {
    if (signal?.aborted === true) throw new Error('restore aborted')
    const file = wanted.get(rel)
    if (file === undefined) {
      const link = links.get(rel)
      if (link === undefined) continue
      const abs = fromRelPosix(root, rel)
      try {
        if (!dryRun) {
          await fs.rm(abs, { force: true })
          try {
            await fs.symlink(link.target, abs)
          } catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
              await fs.symlink(link.target, abs, 'junction')
            } else if (error?.code !== 'EEXIST') {
              throw error
            }
          }
        }
        linked.push(rel)
      } catch (error) {
        failed.push({ rel, code: error?.code ?? 'unknown', message: String(error?.message ?? error) })
      }
      continue
    }
    if (file.restorable === false) {
      skippedReasons.unrestorable += 1
      failed.push({ rel, code: 'unrestorable', message: `snapshot recorded this file as ${file.reason ?? 'unrestorable'}` })
      continue
    }
    let buffer
    try {
      buffer = await store.readBlob(file.sha256)
    } catch {
      skippedReasons.missingBlob += 1
      failed.push({ rel, code: 'missing-blob', message: `blob ${file.sha256} is absent from the store` })
      continue
    }
    if (digest(buffer) !== file.sha256) {
      failed.push({ rel, code: 'corrupt-blob', message: `blob ${file.sha256} failed integrity verification` })
      continue
    }
    try {
      if (!dryRun) await publishBlob(fromRelPosix(root, rel), buffer, file.mode)
      if (isRecreation) recreated.push(rel)
      else restored.push(rel)
    } catch (error) {
      failed.push({ rel, code: error?.code ?? 'unknown', message: String(error?.message ?? error) })
    }
  }

  // Delete files the checkpoint did not contain.
  const deletions = [...plan.added].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const rel of deletions) {
    if (signal?.aborted === true) throw new Error('restore aborted')
    if (excluded(rel)) {
      skippedReasons.excluded += 1
      continue
    }
    const abs = fromRelPosix(root, rel)
    try {
      if (!dryRun) {
        const stat = await fs.lstat(abs)
        if (stat.isDirectory()) continue
        if (options.trashDir !== undefined) {
          const target = join(options.trashDir, ...rel.split('/'))
          await fs.mkdir(dirname(target), { recursive: true })
          await withRetry(() => fs.rename(abs, target))
        } else {
          await withRetry(() => fs.rm(abs, { force: true }))
        }
      }
      removedFiles.push(rel)
    } catch (error) {
      failed.push({ rel, code: error?.code ?? 'unknown', message: String(error?.message ?? error) })
    }
  }

  // Remove directories that only existed after the checkpoint, deepest first.
  let dirsRemoved = 0
  const wantedDirs = new Set(manifest.dirs ?? [])
  const extraDirs = await listExtraDirs(root, wantedDirs, excluded)
  if (!dryRun && extraDirs.length > 0) {
    dirsRemoved = await removeEmptyDirs(root, extraDirs)
  } else {
    dirsRemoved = dryRun ? extraDirs.length : 0
  }

  return {
    root,
    dryRun,
    restored: restored.length,
    recreated: recreated.length,
    deleted: removedFiles.length,
    createdDirs: created.length,
    removedDirs: dirsRemoved,
    symlinks: linked.length,
    unchanged: plan.unchanged,
    skippedReasons,
    failed,
    plan: {
      added: plan.added.slice(0, 200),
      changed: plan.changed.slice(0, 200),
      removed: plan.removed.slice(0, 200),
    },
    unrestorable: plan.unrestorable.slice(0, 200),
    startedAt,
    finishedAt: Date.now(),
  }
}

/** List directories present on disk that the manifest did not record. */
async function listExtraDirs(root, wantedDirs, excluded) {
  const extra = []
  const queue = ['']
  while (queue.length > 0) {
    const relDir = queue.shift()
    const absDir = relDir === '' ? root : fromRelPosix(root, relDir)
    const { entries } = await readChildren(root, absDir)
    for (const [rel, entry] of entries) {
      if (excluded(rel)) continue
      if (!entry.isDirectory()) continue
      if (!wantedDirs.has(rel)) extra.push(rel)
      queue.push(rel)
    }
  }
  return extra
}

/** Absolute path of a manifest entry, exported for callers that preview a plan. */
export function manifestPath(root, rel) {
  return resolve(fromRelPosix(root, rel))
}
