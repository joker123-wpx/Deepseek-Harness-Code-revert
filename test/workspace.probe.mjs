/**
 * Workspace snapshot / diff / restore round-trip test.
 *
 * Exercises the real engine in a throwaway directory inside this repository:
 * nothing outside `test/.tmp` is touched.
 *
 * Run: node test/workspace.probe.mjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RewindStore } from '../lib/store.js'
import { diffWorkspace, snapshotWorkspace, restoreWorkspace } from '../lib/workspace.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const sandbox = join(here, '.tmp', `workspace-${Date.now().toString(36)}`)
const root = join(sandbox, 'ws')
const storeRoot = join(sandbox, 'store')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

const write = async (rel, content) => {
  const path = join(root, ...rel.split('/'))
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
}
const read = async (rel) => {
  try {
    return await fs.readFile(join(root, ...rel.split('/')), 'utf8')
  } catch {
    return undefined
  }
}
const exists = async (rel) => {
  try {
    await fs.stat(join(root, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

await fs.mkdir(root, { recursive: true })
await write('a.txt', 'A1')
await write('dir/b.txt', 'B1')
await write('dir/nested/c.txt', 'C1')
await write('node_modules/dep/index.js', 'module.exports = 1')
await write('.git/config', '[core]')
await write('build.log', 'noise')
await write('.env', 'SECRET=1')
await fs.writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254]))

const store = new RewindStore({ root: storeRoot })
await store.init()

// ── snapshot ────────────────────────────────────────────────────────────────
const first = await snapshotWorkspace(root, { store })
const names = first.manifest.files.map((file) => file.rel).sort()
check('snapshot records regular files', names.join(',') === '.env,a.txt,bin.dat,dir/b.txt,dir/nested/c.txt', names.join(','))
check('node_modules excluded', !names.some((name) => name.startsWith('node_modules')))
check('vcs metadata excluded', !names.some((name) => name.startsWith('.git')))
check('suffix-excluded files skipped', !names.includes('build.log'))
check('directories recorded', first.manifest.dirs.sort().join(',') === 'dir,dir/nested')
check('first snapshot hashed every file', first.counters.hashed === 5 && first.counters.reused === 0, JSON.stringify(first.counters))

// ── incremental snapshot reuses unchanged hashes ────────────────────────────
const previousIndex = new Map(first.manifest.files.map((file) => [file.rel, file]))
const second = await snapshotWorkspace(root, { store, previous: previousIndex })
check('second snapshot reused every unchanged hash', second.counters.reused === 5 && second.counters.hashed === 0, JSON.stringify(second.counters))
const blobCountBefore = (await store.blobUsage()).count

// ── mutate, then diff ───────────────────────────────────────────────────────
await write('a.txt', 'A2')
await fs.rm(join(root, 'dir', 'b.txt'))
await write('new.txt', 'NEW')
const diff = await diffWorkspace(root, first.manifest)
check('diff sees the modified file', diff.changed.join(',') === 'a.txt', diff.changed.join(','))
check('diff sees the deleted file', diff.removed.join(',') === 'dir/b.txt', diff.removed.join(','))
check('diff sees the created file', diff.added.join(',') === 'new.txt', diff.added.join(','))
check('diff counts unchanged files', diff.unchanged >= 3, String(diff.unchanged))

// ── dry run leaves the workspace alone ──────────────────────────────────────
const dry = await restoreWorkspace(root, first.manifest, { store, dryRun: true })
check('dry run reports the plan without writing', dry.restored === 1 && dry.recreated === 1 && dry.deleted === 1,
  `restored=${dry.restored} recreated=${dry.recreated} deleted=${dry.deleted}`)
check('dry run did not touch the modified file', (await read('a.txt')) === 'A2')
check('dry run did not remove the created file', await exists('new.txt'))

// ── real restore ────────────────────────────────────────────────────────────
const restored = await restoreWorkspace(root, first.manifest, { store })
check('restore rewrote the modified file', (await read('a.txt')) === 'A1', String(await read('a.txt')))
check('restore recreated the deleted file', (await read('dir/b.txt')) === 'B1')
check('restore removed the created file', !(await exists('new.txt')))
check('restore reported counts', restored.restored === 1 && restored.recreated === 1 && restored.deleted === 1 && restored.failed.length === 0,
  JSON.stringify({ restored: restored.restored, recreated: restored.recreated, deleted: restored.deleted, failed: restored.failed }))
const binary = await fs.readFile(join(root, 'bin.dat'))
check('binary file round-tripped byte for byte', binary.length === 5 && binary[3] === 255 && binary[4] === 254)

// ── restore is idempotent ───────────────────────────────────────────────────
const again = await restoreWorkspace(root, first.manifest, { store })
check('second restore is a no-op', again.restored === 0 && again.recreated === 0 && again.deleted === 0,
  JSON.stringify({ restored: again.restored, recreated: again.recreated, deleted: again.deleted }))

// ── blob de-duplication ─────────────────────────────────────────────────────
await write('a.txt', 'A1')
const third = await snapshotWorkspace(root, { store, previous: new Map(first.manifest.files.map((file) => [file.rel, file])) })
check('reverting to identical content stored no new blobs', (await store.blobUsage()).count === blobCountBefore,
  `before=${blobCountBefore} after=${(await store.blobUsage()).count}`)
check('incremental snapshot still works after content reverted', third.manifest.files.length === 5)

// ── unrestorable entries are reported, never written ────────────────────────
const bigRoot = join(sandbox, 'big')
await fs.mkdir(bigRoot, { recursive: true })
await fs.writeFile(join(bigRoot, 'huge.bin'), Buffer.alloc(2048, 7))
const bigStore = new RewindStore({ root: join(sandbox, 'store2') })
await bigStore.init()
const big = await snapshotWorkspace(bigRoot, { store: bigStore, maxBlobBytes: 1024 })
check('oversized file recorded as unrestorable', big.manifest.files[0]?.restorable === false && big.manifest.files[0]?.reason === 'too-large')
const bigPlan = await diffWorkspace(bigRoot, big.manifest)
check('oversized file surfaces in the unrestorable list', bigPlan.unrestorable.length === 1)

// ── symlinks are recorded, not followed ─────────────────────────────────────
let symlinkOutcome = 'skipped'
try {
  await fs.symlink(join(root, 'a.txt'), join(root, 'link.txt'), 'file')
  symlinkOutcome = 'created'
} catch (error) {
  symlinkOutcome = `unavailable:${error.code ?? 'unknown'}`
}
if (symlinkOutcome === 'created') {
  const withLink = await snapshotWorkspace(root, { store })
  check('symlink recorded as a link, not as content', withLink.manifest.symlinks.some((link) => link.rel === 'link.txt'))
  await fs.rm(join(root, 'link.txt'), { force: true })
  const recreated = await restoreWorkspace(root, withLink.manifest, { store })
  check('symlink recreated on restore', recreated.symlinks === 1 && await exists('link.txt'), JSON.stringify(recreated.failed))
} else {
  console.log(`SKIP  symlink checks (${symlinkOutcome})`)
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await fs.rm(sandbox, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
