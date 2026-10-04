/**
 * Durable checkpoint store for dsh-plugin-rewind.
 *
 * Layout under `<DSH_HOME>/rewind/v1`:
 * ```
 *   blobs/<aa>/<sha256>                  content-addressed file bytes (deduplicated)
 *   manifests/<sessionId>/<cpId>.json    one workspace manifest per checkpoint
 *   index/<sessionId>.json               the checkpoint list for one session
 *   trash/<cpId>/...                     files removed by a rollback (undo-able)
 * ```
 * Everything is written with a same-directory temp file plus rename, so a torn
 * write cannot leave a half-parsed index behind. The module deliberately has no
 * `@deepseek-ai/*` imports: it stays loadable in a plain Node process, which is
 * what makes the engine testable outside the harness.
 *
 * @module dsh-plugin-rewind/store
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/** Replace characters a Windows or POSIX path cannot carry. */
export function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * The manifest file ids one checkpoint owns.
 *
 * A checkpoint covers every workspace root the conversation belongs to, so it
 * holds one manifest per root: `<id>` for the first, `<id>~<n>` for the rest.
 * Records written before multi-root support have no `roots` list and own
 * exactly one file.
 */
export function manifestFilesOf(checkpoint) {
  if (Array.isArray(checkpoint?.roots) && checkpoint.roots.length > 0) {
    return checkpoint.roots
      .map((entry) => (typeof entry?.file === 'string' ? entry.file : undefined))
      .filter((file) => file !== undefined)
  }
  return typeof checkpoint?.id === 'string' ? [checkpoint.id] : []
}

/** The manifest file id for one root index of a checkpoint. */
export function manifestFileFor(checkpointId, rootIndex) {
  return rootIndex === 0 ? checkpointId : `${checkpointId}~${rootIndex}`
}

/** Write one file atomically: temp file in the same directory, then rename. */
async function writeJsonAtomic(path, value) {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, path)
}

/** Read and parse a JSON file, returning `undefined` when it is absent or invalid. */
async function readJson(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Durable checkpoint storage rooted at one directory. */
export class RewindStore {
  /**
   * @param options - `root` is the store directory; `retainCheckpoints` bounds
   *   how many checkpoints per session the index keeps.
   */
  constructor(options = {}) {
    this.root = options.root
    this.retainCheckpoints = options.retainCheckpoints ?? 200
    /** Per-session serialization chain: two snapshots never race on one index. */
    this.locks = new Map()
  }

  /** Create the store's directory skeleton. */
  async init() {
    await fs.mkdir(join(this.root, 'blobs'), { recursive: true })
    await fs.mkdir(join(this.root, 'manifests'), { recursive: true })
    await fs.mkdir(join(this.root, 'index'), { recursive: true })
    await fs.mkdir(join(this.root, 'trash'), { recursive: true })
  }

  /** Run `task` with the per-session lock held. */
  async withLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const chained = previous.then(() => gate)
    this.locks.set(key, chained)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.locks.get(key) === chained) this.locks.delete(key)
    }
  }

  /** Absolute path of one blob. */
  blobPath(sha256) {
    return join(this.root, 'blobs', sha256.slice(0, 2), sha256)
  }

  /** Whether a blob is already stored. */
  async hasBlob(sha256) {
    try {
      await fs.access(this.blobPath(sha256))
      return true
    } catch {
      return false
    }
  }

  /**
   * Store one buffer under its content address. Writing an existing address is a
   * no-op, which is what makes repeated snapshots of an unchanged tree cheap.
   */
  async putBlob(buffer, sha256) {
    const path = this.blobPath(sha256)
    if (await this.hasBlob(sha256)) return sha256
    await fs.mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await fs.writeFile(temp, buffer)
    await fs.rename(temp, path)
    return sha256
  }

  /** Read one blob; throws when it is absent. */
  async readBlob(sha256) {
    return fs.readFile(this.blobPath(sha256))
  }

  /** Absolute path of one checkpoint's manifest file. */
  manifestPath(sessionId, checkpointId) {
    return join(this.root, 'manifests', safeId(sessionId), `${safeId(checkpointId)}.json`)
  }

  /** Persist one workspace manifest. */
  async writeManifest(sessionId, checkpointId, manifest) {
    await writeJsonAtomic(this.manifestPath(sessionId, checkpointId), manifest)
  }

  /** Read one workspace manifest, or `undefined` when it is gone. */
  async readManifest(sessionId, checkpointId) {
    return readJson(this.manifestPath(sessionId, checkpointId))
  }

  /** Delete one checkpoint's manifest. */
  async deleteManifest(sessionId, checkpointId) {
    await fs.rm(this.manifestPath(sessionId, checkpointId), { force: true })
  }

  /** Absolute path of one session's checkpoint index. */
  indexPath(sessionId) {
    return join(this.root, 'index', `${safeId(sessionId)}.json`)
  }

  /**
   * Read one session's checkpoint index, normalising absent or corrupt files to
   * an empty index so a damaged store degrades instead of failing to mount.
   */
  async loadIndex(sessionId) {
    const raw = await readJson(this.indexPath(sessionId))
    if (raw === undefined || typeof raw !== 'object' || raw === null) {
      return { sessionId, cwd: undefined, checkpoints: [] }
    }
    return {
      sessionId,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      parentSession: typeof raw.parentSession === 'string' ? raw.parentSession : undefined,
      checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
    }
  }

  /** Persist one session's checkpoint index, newest first, bounded by retention. */
  async saveIndex(index) {
    const seen = new Set()
    const checkpoints = []
    for (const checkpoint of index.checkpoints ?? []) {
      if (checkpoint?.id === undefined || seen.has(checkpoint.id)) continue
      seen.add(checkpoint.id)
      checkpoints.push(checkpoint)
    }
    checkpoints.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const kept = checkpoints.slice(0, this.retainCheckpoints)
    const dropped = checkpoints.slice(kept.length)
    await writeJsonAtomic(this.indexPath(index.sessionId), {
      sessionId: index.sessionId,
      cwd: index.cwd,
      parentSession: index.parentSession,
      checkpoints: kept,
    })
    for (const checkpoint of dropped) {
      for (const file of manifestFilesOf(checkpoint)) {
        await this.deleteManifest(index.sessionId, file)
      }
    }
    return kept
  }
  /** Read every session index this store holds. */
  async listIndexes() {
    const indexDir = join(this.root, 'index')
    let names = []
    try {
      names = await fs.readdir(indexDir)
    } catch {
      return []
    }
    const indexes = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const raw = await readJson(join(indexDir, name))
      if (raw === undefined || typeof raw !== 'object' || raw === null) continue
      indexes.push({
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : name.replace(/\.json$/, ''),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        parentSession: typeof raw.parentSession === 'string' ? raw.parentSession : undefined,
        checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
      })
    }
    return indexes
  }

  /**
   * Add or replace one checkpoint, written under the session lock so two
   * concurrent turn boundaries cannot lose each other's entry.
   */
  async upsertCheckpoint(sessionId, checkpoint, cwd, parentSession) {
    return this.withLock(`index:${sessionId}`, async () => {
      const index = await this.loadIndex(sessionId)
      const checkpoints = (index.checkpoints ?? []).filter((entry) => entry.id !== checkpoint.id)
      checkpoints.push(checkpoint)
      return this.saveIndex({
        sessionId,
        cwd: cwd ?? index.cwd,
        parentSession: parentSession ?? index.parentSession,
        checkpoints,
      })
    })
  }

  /** Absolute directory a rollback uses to park files it deletes. */
  trashDir(checkpointId) {
    return join(this.root, 'trash', safeId(checkpointId))
  }

  /** Delete every blob this store holds whose checkpoint references are gone. */
  async collectGarbage() {
    const referenced = new Set()
    const indexDir = join(this.root, 'index')
    let indexFiles = []
    try {
      indexFiles = await fs.readdir(indexDir)
    } catch {
      return { removed: 0, kept: 0 }
    }
    for (const name of indexFiles) {
      if (!name.endsWith('.json')) continue
      const raw = await readJson(join(indexDir, name))
      for (const checkpoint of raw?.checkpoints ?? []) {
        if (checkpoint.manifest !== true) continue
        const manifest = await this.readManifest(raw.sessionId ?? name.replace(/\.json$/, ''), checkpoint.id)
        for (const file of manifest?.files ?? []) {
          if (typeof file.sha256 === 'string') referenced.add(file.sha256)
        }
      }
    }
    let removed = 0
    let kept = 0
    const blobsDir = join(this.root, 'blobs')
    let prefixes = []
    try {
      prefixes = await fs.readdir(blobsDir)
    } catch {
      return { removed: 0, kept: 0 }
    }
    for (const prefix of prefixes) {
      const dir = join(blobsDir, prefix)
      let names = []
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (referenced.has(name)) {
          kept += 1
        } else {
          await fs.rm(join(dir, name), { force: true })
          removed += 1
        }
      }
    }
    return { removed, kept }
  }

  /** Total bytes and entry count of the blob store, for the status panel. */
  async blobUsage() {
    let bytes = 0
    let count = 0
    const blobsDir = join(this.root, 'blobs')
    let prefixes = []
    try {
      prefixes = await fs.readdir(blobsDir)
    } catch {
      return { bytes: 0, count: 0 }
    }
    for (const prefix of prefixes) {
      let names = []
      try {
        names = await fs.readdir(join(blobsDir, prefix))
      } catch {
        continue
      }
      for (const name of names) {
        try {
          const stat = await fs.stat(join(blobsDir, prefix, name))
          bytes += stat.size
          count += 1
        } catch {
          /* raced with a prune; ignore */
        }
      }
    }
    return { bytes, count }
  }
}
