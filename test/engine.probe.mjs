/**
 * Host-half integration test: the rollback engine driven end to end against a
 * REAL `@deepseek-ai/dsh-session` instance and a throwaway workspace.
 *
 * It covers: checkpoint creation (initial + per turn), conversation-only
 * backfill, upgrading a backfilled entry into a full snapshot, the overview
 * payload the browser half consumes, conversation rewind by surface
 * replacement, workspace rollback with the automatic safety checkpoint, and
 * checkpoint retention/GC.
 *
 * Run: node test/engine.probe.mjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { RewindEngine } from '../lib/engine.js'
import { analyzeSession } from '../lib/conversation.js'
import { RewindStore } from '../lib/store.js'

const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)
const { Session } = await load('@deepseek-ai/dsh-session/lib/index.js')

const here = fileURLToPath(new URL('.', import.meta.url))
const sandbox = join(here, '.tmp', `engine-${Date.now().toString(36)}`)
const root = join(sandbox, 'ws')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

await fs.mkdir(root, { recursive: true })
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

// ── fixtures ────────────────────────────────────────────────────────────────
const sessions = new Map()
const makeSession = (id, header = {}) => {
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: root,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...header,
  })
  sessions.set(id, session)
  return session
}

const store = new RewindStore({ root: join(sandbox, 'store'), retainCheckpoints: 50 })
/** Registered workspaces, filled in by the multi-root section below. */
const workspaces = []
const engine = new RewindEngine({
  store,
  config: {},
  sessions: (id) => sessions.get(id),
  listSessions: () => [...sessions.values()],
  listWorkspaces: () => workspaces,
  logger: () => {},
})
await engine.init()

const sessionId = 'session-probe-0001'
const session = makeSession(sessionId)

/** A realistic assistant message: id + model source are mandatory on replay. */
const assistantMessage = (text) => ({
  id: `msg-${Math.random().toString(36).slice(2, 10)}`,
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  content: [{ type: 'text', text }],
})

/** Append one complete turn with a human prompt. */
function appendTurn(turn, prompt) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', {
    id: `u-${turn}`,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${turn}` },
    content: [{ type: 'text', text: prompt }],
  }, { surfaceOp: 'append' })
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text', text: `answer ${turn}` } })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(`answer ${turn}`),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return user
}

// ── initial checkpoint ──────────────────────────────────────────────────────
await write('src/main.js', 'console.log("v1")\n')
await write('README.md', 'v1\n')
const initial = await engine.createCheckpoint({
  sessionId,
  afterTurn: 0,
  kind: 'auto',
  withManifest: true,
  label: '初始状态',
})
check('initial checkpoint carries a file snapshot', initial.manifest === true && initial.stats.files >= 2, JSON.stringify(initial.stats))
check('initial checkpoint lists hashed files', initial.hashed >= 2, String(initial.hashed))

// ── turn 1, then its checkpoint ─────────────────────────────────────────────
const user1 = appendTurn(1, '把版本号改成 v2')
await write('src/main.js', 'console.log("v2")\n')
await write('src/new.js', 'export const added = true\n')
await fs.rm(join(root, 'README.md'))
const after1 = await engine.createCheckpoint({
  sessionId,
  afterTurn: 1,
  kind: 'auto',
  withManifest: true,
  label: '第 1 轮 · 把版本号改成 v2',
  prompt: '把版本号改成 v2',
})
check('a snapshot after real changes hashes exactly those files', after1.hashed === 2 && after1.reused === 0,
  `hashed=${after1.hashed} reused=${after1.reused}`)

// ── turn 2, then its checkpoint ─────────────────────────────────────────────
const user2 = appendTurn(2, '再加一个文件')
await write('src/extra.js', 'export const extra = 2\n')
const after2 = await engine.createCheckpoint({ sessionId, afterTurn: 2, kind: 'auto', withManifest: true, prompt: '再加一个文件' })
check('the next snapshot reuses unchanged file hashes', after2.reused === 2 && after2.hashed === 1,
  `hashed=${after2.hashed} reused=${after2.reused}`)

// ── overview ────────────────────────────────────────────────────────────────
const overview = await engine.overview(sessionId)
check('overview lists one branch', overview.sessions.length === 1 && overview.sessions[0].id === sessionId)
check('overview lists every checkpoint', overview.checkpoints.length === 3, String(overview.checkpoints.length))
const cp0 = overview.checkpoints.find((checkpoint) => checkpoint.afterTurn === 0)
const cp1 = overview.checkpoints.find((checkpoint) => checkpoint.afterTurn === 1)
const cp2 = overview.checkpoints.find((checkpoint) => checkpoint.afterTurn === 2)
check('initial checkpoint targets turn 1 and is reachable', cp0.targetUserSeq === user1.seq && cp0.reachable === true)
check('initial checkpoint cannot fork (no completed turn before it)', cp0.canFork === false && cp0.forkAtSeq === undefined)
check('turn-1 checkpoint targets turn 2 and can fork at its own turn end', cp1.targetUserSeq === user2.seq && cp1.canFork === true,
  `forkAtSeq=${cp1.forkAtSeq}`)
check('the newest checkpoint has no next turn yet', cp2.hasNextTurn === false && cp2.reachable === false && cp2.alreadyRewound === false)
check('overview exposes the surface message count', overview.surfaces[sessionId].messageCount === 4, String(overview.surfaces[sessionId].messageCount))

// ── plan (dry run) ──────────────────────────────────────────────────────────
const plan = await engine.plan(cp1.id, { conversation: 'inplace', workspace: 'restore' })
check('plan reports what the conversation rewind would drop', plan.conversation.ok === true && plan.conversation.droppedTurns.length === 1,
  JSON.stringify(plan.conversation.droppedTurns))
check('plan reports the file diff without touching disk', plan.workspace.ok === true && plan.workspace.summary.dryRun === true)
check('plan kept the workspace untouched', (await read('src/extra.js')) === 'export const extra = 2\n')

// ── workspace rollback to just after turn 1 ─────────────────────────────────
const rollback = await engine.apply(cp1.id, { conversation: 'none', workspace: 'restore' })
check('rollback created a safety checkpoint first', rollback.safety !== undefined && rollback.safety.kind === 'safety' && rollback.safety.manifest === true)
check('rollback removed the file created after the checkpoint', (await read('src/extra.js')) === undefined)
check('rollback left the file that the checkpoint already had', (await read('src/main.js')) === 'console.log("v2")\n', JSON.stringify(await read('src/main.js')))
check('rollback summary is complete', rollback.workspace.deleted === 1 && rollback.workspace.failed.length === 0, JSON.stringify(rollback.workspace.plan))

// ── the safety checkpoint can undo that rollback ────────────────────────────
const overviewWithSafety = await engine.overview(sessionId)
const safety = overviewWithSafety.checkpoints.find((checkpoint) => checkpoint.kind === 'safety')
check('safety checkpoint is visible in the tree', safety !== undefined)
check('safety checkpoint carries a file snapshot', safety?.manifest === true && safety?.canRestoreWorkspace === true)
const undo = await engine.apply(safety.id, { conversation: 'none', workspace: 'restore' })
check('restoring the safety checkpoint brings the deleted file back', (await read('src/extra.js')) === 'export const extra = 2\n')
check('undo rollback did not fail any file', undo.workspace.failed.length === 0)
const safetyCount = (await engine.overview(sessionId)).checkpoints.filter((checkpoint) => checkpoint.kind === 'safety').length
check('only one safety checkpoint is kept per session', safetyCount === 1, String(safetyCount))

// ── rollback all the way to the initial state ───────────────────────────────
const rollbackZero = await engine.apply(cp0.id, { conversation: 'none', workspace: 'restore' })
check('rollback to the initial checkpoint restored the deleted file', (await read('README.md')) === 'v1\n', JSON.stringify(await read('README.md')))
check('rollback to the initial checkpoint reverted the edited file', (await read('src/main.js')) === 'console.log("v1")\n')
check('rollback to the initial checkpoint removed the created file', (await read('src/new.js')) === undefined)
check('rollback to the initial checkpoint reported every category',
  rollbackZero.workspace.restored === 1 && rollbackZero.workspace.recreated === 1 && rollbackZero.workspace.deleted === 2,
  JSON.stringify(rollbackZero.workspace.plan))
await write('src/main.js', 'console.log("v2")\n')
await write('src/new.js', 'export const added = true\n')
await write('src/extra.js', 'export const extra = 2\n')
await fs.rm(join(root, 'README.md'))

// ── conversation rewind (surface replacement) ───────────────────────────────
const before = session.deriveMessages().length
const inplace = await engine.apply(cp1.id, { conversation: 'inplace', workspace: 'none' })
const after = session.deriveMessages().length
check('in-place rewind dropped the turns after the checkpoint', after < before, `${before} -> ${after}`)
check('in-place rewind reported the dropped turns', inplace.conversation.mode === 'inplace' && inplace.conversation.droppedTurns.length === 1,
  JSON.stringify(inplace.conversation))
check('the abandoned events stay in the append-only log', session.events.some((event) => event.seq === user2.seq))
const overviewAfter = await engine.overview(sessionId)
const cp1After = overviewAfter.checkpoints.find((checkpoint) => checkpoint.id === cp1.id)
check('the tree now marks the rewound turn as an abandoned branch',
  overviewAfter.checkpoints.some((checkpoint) => checkpoint.abandoned === true),
  JSON.stringify(overviewAfter.checkpoints.map((checkpoint) => [checkpoint.afterTurn, checkpoint.abandoned, checkpoint.alreadyRewound])))
check('a second rewind of the same turn is refused', cp1After.reachable === false && cp1After.alreadyRewound === true)
let refused = false
try {
  await engine.apply(cp1.id, { conversation: 'inplace', workspace: 'none' })
} catch (error) {
  refused = error.code === 'already-rewound'
}
check('applying the same rewind twice throws already-rewound', refused)

// ── backfill of historical turns ────────────────────────────────────────────
const freshId = 'session-probe-0002'
const fresh = makeSession(freshId)
for (let turn = 1; turn <= 3; turn += 1) {
  fresh.append('turn/start', { turn })
  fresh.append('user/message', {
    id: `h-${turn}`,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${turn}` },
    content: [{ type: 'text', text: `历史提问 ${turn}` }],
  }, { surfaceOp: 'append' })
  fresh.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(`历史回答 ${turn}`),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  fresh.append('turn/end', { turn, reason: { kind: 'completed' } })
}
const backfilled = await engine.backfill(freshId)
check('backfill created one conversation-only checkpoint per turn', backfilled.created === 3, JSON.stringify(backfilled))
const freshOverview = await engine.overview(freshId)
const freshOwn = freshOverview.checkpoints.filter((checkpoint) => checkpoint.sessionId === freshId)
check('backfilled checkpoints have no file snapshot',
  freshOwn.length === 3 && freshOwn.every((checkpoint) => checkpoint.manifest === false && checkpoint.canRestoreWorkspace === false),
  JSON.stringify(freshOwn.map((checkpoint) => [checkpoint.afterTurn, checkpoint.manifest])))
check('backfilled checkpoints keep their prompt', freshOwn.some((checkpoint) => checkpoint.prompt === '历史提问 2'))
const backfillAgain = await engine.backfill(freshId)
check('backfill is idempotent', backfillAgain.created === 0)

// ── backfilled entries upgrade to full snapshots on the same turn ───────────
const upgraded = await engine.createCheckpoint({ sessionId: freshId, afterTurn: 3, kind: 'auto', withManifest: true, prompt: '历史提问 3' })
check('upgrading reuses the backfilled checkpoint id', upgraded.id === freshOwn.find((checkpoint) => checkpoint.afterTurn === 3)?.id)
check('upgraded checkpoint now has a snapshot', upgraded.manifest === true)
const upgradedIndex = await store.loadIndex(freshId)
check('upgrade replaced rather than duplicated the entry',
  upgradedIndex.checkpoints.filter((checkpoint) => checkpoint.afterTurn === 3).length === 1,
  JSON.stringify(upgradedIndex.checkpoints.map((checkpoint) => [checkpoint.afterTurn, checkpoint.manifest])))

// ── forked children are separate branches ──────────────────────────────────
// A real fork seeds the child with the parent's prefix: turns 1 and 2 here.
const parentEvents = fresh.events
const childId = 'session-probe-0002-child'
const child = Session.create(childId, parentEvents.slice(0, 8), {
  version: 0,
  id: childId,
  createdAt: Date.now(),
  cwd: root,
  delegationDepth: 0,
  agentPreset: 'standard',
  parentSession: freshId,
  seedLength: 8,
})
sessions.set(childId, child)
// The child then does its own turn 3.
child.append('turn/start', { turn: 3 })
child.append('user/message', {
  id: 'c-3',
  role: 'user',
  source: { kind: 'user', rpcId: 'rpc-child' },
  content: [{ type: 'text', text: '分叉后的提问' }],
}, { surfaceOp: 'append' })
child.append('assistant/message', {
  turn: 3,
  step: 1,
  message: assistantMessage('分叉后的回答'),
}, { surfaceOp: 'append', sourceEventSeqs: [] })
child.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

const childOverview = await engine.overview(childId)
check('a forked child appears as its own branch', childOverview.sessions.some((entry) => entry.id === childId && entry.parentSession === freshId))
check('the parent branch is included in the child overview', childOverview.sessions.some((entry) => entry.id === freshId))
const childBackfill = await engine.backfill(childId)
check('backfill skips the inherited (seeded) turns of a fork', childBackfill.created === 1, JSON.stringify(childBackfill))
const childAfter = await engine.overview(childId)
const childOwn = childAfter.checkpoints.filter((checkpoint) => checkpoint.sessionId === childId)
check('the child lane only carries its own turn',
  childOwn.length === 1 && childOwn.every((checkpoint) => checkpoint.afterTurn === 3),
  JSON.stringify(childOwn.map((checkpoint) => checkpoint.afterTurn)))

// ── retention + garbage collection ─────────────────────────────────────────
const gc = await engine.collectGarbage()
check('garbage collection keeps every referenced blob', gc.kept > 0 && gc.removed === 0, JSON.stringify(gc))
const removed = await engine.remove(cp0.id)
check('removing a checkpoint reports success', removed.removed === true)
const afterRemoval = await engine.overview(sessionId)
check('the removed checkpoint is gone from the tree', !afterRemoval.checkpoints.some((checkpoint) => checkpoint.id === cp0.id))
const gcAfterRemoval = await engine.collectGarbage()
check('garbage collection removes only now-unreferenced blobs', gcAfterRemoval.removed >= 0 && gcAfterRemoval.kept > 0, JSON.stringify(gcAfterRemoval))

// ── status ──────────────────────────────────────────────────────────────────
const status = await engine.status()
check('status reports sessions, checkpoints and store usage',
  status.sessions >= 3 && status.checkpoints > 0 && status.blobs.count > 0 && status.liveSessions >= 3, JSON.stringify(status))

// ── vision: repair of a bad checkpoint id ──────────────────────────────────
let missing = false
try {
  await engine.apply('cp-does-not-exist', { workspace: 'restore' })
} catch (error) {
  missing = error.code === 'unknown-checkpoint'
}
check('an unknown checkpoint id is a typed error', missing)

// ── every workspace of the conversation is covered ─────────────────────────
// A conversation can touch more than one directory. The second root here is a
// separate registered workspace attached to the same session, which is exactly
// the case a single-cwd snapshot would silently miss.
const secondRoot = join(sandbox, 'ws2')
await fs.mkdir(join(secondRoot, 'pkg'), { recursive: true })
await fs.writeFile(join(secondRoot, 'pkg', 'mod.js'), 'export const value = 1\n')
await fs.writeFile(join(secondRoot, 'notes.txt'), 'original\n')
const multiId = 'session-probe-multi'
workspaces.push({ path: root, sessionIds: [sessionId, multiId] })
workspaces.push({ path: secondRoot, sessionIds: [multiId] })
const multiSession = makeSession(multiId)
multiSession.append('turn/start', { turn: 1 })
multiSession.append('user/message', {
  id: 'u-multi',
  role: 'user',
  source: { kind: 'user', rpcId: 'rpc-multi' },
  content: [{ type: 'text', text: '两个目录一起改' }],
}, { surfaceOp: 'append' })
multiSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

const roots = await engine.resolveRoots(multiId)
check('root resolution finds both workspaces of the conversation', roots.length === 2, JSON.stringify(roots))
const multiCheckpoint = await engine.createCheckpoint({ sessionId: multiId, afterTurn: 1, kind: 'auto', withManifest: true })
check('the checkpoint snapshots every root', multiCheckpoint.roots?.length === 2 && multiCheckpoint.stats.roots === 2,
  JSON.stringify({ roots: multiCheckpoint.roots?.map((entry) => entry.root), stats: multiCheckpoint.stats }))
check('each root manifest landed in the store',
  (await engine.rootManifests(multiCheckpoint)).length === 2,
  JSON.stringify((await engine.rootManifests(multiCheckpoint)).map((entry) => entry.root)))

// Change files in BOTH roots, then roll back and prove both were restored.
await fs.writeFile(join(root, 'src', 'main.js'), 'console.log("second root untouched")\n')
await fs.writeFile(join(secondRoot, 'pkg', 'mod.js'), 'export const value = 2\n')
await fs.writeFile(join(secondRoot, 'created-later.txt'), 'new\n')
const multiPlan = await engine.plan(multiCheckpoint.id, { workspace: 'restore' })
check('the plan reports one dry run per root', multiPlan.workspace.ok === true && multiPlan.workspace.roots.length === 2,
  JSON.stringify(multiPlan.workspace.roots?.map((entry) => entry.root)))
check('the aggregated plan sees changes in each root',
  multiPlan.workspace.summary.plan.changed.length >= 2 && multiPlan.workspace.summary.plan.added.length === 1,
  JSON.stringify(multiPlan.workspace.summary.plan))

const multiRollback = await engine.apply(multiCheckpoint.id, { workspace: 'restore' })
check('the rollback restored the second workspace too',
  (await fs.readFile(join(secondRoot, 'pkg', 'mod.js'), 'utf8')) === 'export const value = 1\n',
  JSON.stringify(await fs.readFile(join(secondRoot, 'pkg', 'mod.js'), 'utf8')))
check('the rollback removed the file created in the second workspace',
  await fs.stat(join(secondRoot, 'created-later.txt')).then(() => false, () => true))
check('the rollback restored the first workspace as well',
  (await fs.readFile(join(root, 'src', 'main.js'), 'utf8')) === 'console.log("v2")\n')
check('the rollback summary aggregates both roots',
  multiRollback.workspace.roots.length === 2 && multiRollback.workspace.failed.length === 0,
  JSON.stringify({ roots: multiRollback.workspace.roots.length, restored: multiRollback.workspace.restored, deleted: multiRollback.workspace.deleted }))
check('the overview reports a host build id', typeof (await engine.overview(sessionId)).build?.host === 'string',
  JSON.stringify((await engine.overview(sessionId)).build))
check('root resolution is reported by status', (await engine.status()).roots.length >= 2)

// ── a compaction is not a rewind ───────────────────────────────────────────
const compactId = 'session-probe-compact'
const compactSession = makeSession(compactId)
const surfaceSeqs = []
for (let turn = 1; turn <= 2; turn += 1) {
  compactSession.append('turn/start', { turn })
  const user = compactSession.append('user/message', {
    id: `c-${turn}`,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${turn}` },
    content: [{ type: 'text', text: `第 ${turn} 轮` }],
  }, { surfaceOp: 'append' })
  const assistant = compactSession.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(`回答 ${turn}`),
  }, { surfaceOp: 'append' })
  compactSession.append('turn/end', { turn, reason: { kind: 'completed' } })
  surfaceSeqs.push(user.seq, assistant.seq)
}
// A compaction checkpoint is a `user/message` whose source plugin is `compact`
// and which replaces the range it summarises; it must cite every shadowed node.
compactSession.append('user/message', {
  id: 'compact-summary',
  role: 'user',
  source: { kind: 'user', plugin: 'compact' },
  content: [{ type: 'text', text: '（已压缩的摘要）' }],
}, {
  surfaceOp: { op: 'replace', start: surfaceSeqs[0], end: surfaceSeqs[surfaceSeqs.length - 1] },
  sourceEventSeqs: surfaceSeqs,
})

const compactAnalysis = analyzeSession(compactSession)
check('a compaction is recorded as compacted, not rewound',
  JSON.stringify(compactAnalysis.compactedSeqs) === JSON.stringify(surfaceSeqs)
  && compactAnalysis.rewoundSeqs.length === 0,
  JSON.stringify({ compacted: compactAnalysis.compactedSeqs, rewound: compactAnalysis.rewoundSeqs, expected: surfaceSeqs }))
check('every replacement is classified', compactAnalysis.replacements.length === 1
  && compactAnalysis.replacements[0].kind === 'compaction',
  JSON.stringify(compactAnalysis.replacements))
await engine.backfill(compactId)
const compactOverview = await engine.overview(compactId)
const compactFlags = compactOverview.checkpoints.filter((checkpoint) => checkpoint.sessionId === compactId)
check('the tree marks the compacted turn as compacted',
  compactFlags.some((checkpoint) => checkpoint.compacted === true && checkpoint.alreadyRewound === false),
  JSON.stringify(compactFlags.map((checkpoint) => [checkpoint.afterTurn, checkpoint.compacted, checkpoint.alreadyRewound])))

// ── the host picks a session when the client cannot ────────────────────────
const picked = await engine.overview(undefined)
check('overview without a session id auto-picks one',
  typeof picked.currentSessionId === 'string' && picked.autoSelected === true,
  JSON.stringify({ id: picked.currentSessionId, auto: picked.autoSelected }))
check('the auto-picked overview still carries the tree', picked.checkpoints.length > 0, String(picked.checkpoints.length))

// ── a rewind requested while the agent is working is held, not refused ─────
// The panel is normally used mid-turn; refusing outright made the confirm button
// look dead. The request is queued, reported, and run at the turn boundary.
const queueCp = await engine.createCheckpoint({
  sessionId,
  afterTurn: 1,
  kind: 'manual',
  withManifest: true,
  label: '排队测试',
  prompt: 'queue',
})
engine.enterTool(sessionId)
// The workspace action is used here because this session's first turn was already
// rewound by the conversation tests above; the queue itself is action-agnostic.
const queuedOutcome = await engine.applyOrQueue(queueCp.id, { conversation: 'none', workspace: 'restore' })
check('a rewind requested during a tool call is queued, not refused',
  queuedOutcome.queued === true && queuedOutcome.checkpointId === queueCp.id,
  JSON.stringify(queuedOutcome))
const pendingSeen = engine.pendingOf(sessionId)
check('the panel can see what is waiting',
  pendingSeen?.checkpointId === queueCp.id && pendingSeen.workspace === 'restore',
  JSON.stringify(pendingSeen))
check('a queued rewind is held while the tool call is still running',
  (await engine.drainPending(sessionId)) === undefined && engine.pendingOf(sessionId) !== undefined)
engine.exitTool(sessionId)
const drained = await engine.drainPending(sessionId)
check('the queued rewind runs once the tool call finishes', drained !== undefined,
  JSON.stringify(engine.pendingResultOf(sessionId)))
check('the outcome of the queued rewind is reported',
  engine.pendingResultOf(sessionId)?.ok === true
  && engine.pendingResultOf(sessionId)?.checkpointId === queueCp.id,
  JSON.stringify(engine.pendingResultOf(sessionId)))
check('nothing is left queued after it ran', engine.pendingOf(sessionId) === undefined)

const cancelCp = await engine.createCheckpoint({
  sessionId, afterTurn: 2, kind: 'manual', withManifest: true, label: '取消测试', prompt: 'cancel',
})
engine.enterTool(sessionId)
await engine.applyOrQueue(cancelCp.id, { conversation: 'none', workspace: 'restore' })
check('a queued rewind can be called off',
  engine.cancelPending(sessionId).cancelled === true && engine.pendingOf(sessionId) === undefined)
engine.exitTool(sessionId)
check('cancelling leaves nothing to drain', (await engine.drainPending(sessionId)) === undefined)

// ── the overview reports the queue so the panel can say "queued" ───────────
engine.enterTool(sessionId)
await engine.applyOrQueue(queueCp.id, { conversation: 'none', workspace: 'restore' })
const queuedOverview = await engine.overview(sessionId)
check('the overview carries the pending rewind',
  queuedOverview.queue?.pending?.checkpointId === queueCp.id,
  JSON.stringify(queuedOverview.queue))
engine.exitTool(sessionId)
await engine.drainPending(sessionId)
const drainedOverview = await engine.overview(sessionId)
check('the overview carries the outcome of the last queued rewind',
  drainedOverview.queue?.pending === undefined && drainedOverview.queue?.last !== undefined,
  JSON.stringify(drainedOverview.queue))

// ── a held rewind must not be stranded by a busy agent ─────────────────────
// One attempt at the turn boundary is not enough: this agent continues into a
// new round by itself, so the drain can find a tool call already in flight. The
// request is retried on a timer instead of being dropped, which is what made a
// confirmed rewind vanish without a trace.
engine.enterTool(sessionId)
await engine.applyOrQueue(queueCp.id, { conversation: 'none', workspace: 'restore' })
await engine.drainPending(sessionId)
check('a drain that finds the agent busy keeps the request and schedules a retry',
  engine.pendingOf(sessionId)?.checkpointId === queueCp.id && engine.drainTimers.size === 1,
  JSON.stringify({ pending: engine.pendingOf(sessionId)?.checkpointId, timers: engine.drainTimers.size }))
check('the waiting counter advances', (engine.pending.get(sessionId)?.waited ?? 0) >= 1,
  String(engine.pending.get(sessionId)?.waited))
check('cancelling clears the retry timer too',
  engine.cancelPending(sessionId).cancelled === true && engine.drainTimers.size === 0
  && engine.pendingOf(sessionId) === undefined)

await engine.applyOrQueue(queueCp.id, { conversation: 'none', workspace: 'restore' })
engine.pending.get(sessionId).waited = 41
await engine.drainPending(sessionId)
check('a rewind that waits too long reports a timeout instead of waiting forever',
  engine.pendingOf(sessionId) === undefined
  && engine.pendingResultOf(sessionId)?.ok === false
  && String(engine.pendingResultOf(sessionId)?.message ?? '').includes('超时'),
  JSON.stringify(engine.pendingResultOf(sessionId)))
engine.exitTool(sessionId)

// ── provenance telemetry: which browser build called, and what it asked ────
engine.noteClient('2026-10-04.5', 'apply')
engine.recordRpc({ method: 'apply', client: '2026-10-04.5', params: { checkpointId: 'x' }, outcome: 'queued' })
const telemetry = await engine.status()
check('status reports the calling browser build',
  telemetry.client?.build === '2026-10-04.5' && typeof telemetry.client.at === 'number',
  JSON.stringify(telemetry.client))
check('status keeps a log of state-changing calls',
  Array.isArray(telemetry.rpcLog)
  && telemetry.rpcLog.some((entry) => entry.method === 'apply' && entry.outcome === 'queued'),
  JSON.stringify(telemetry.rpcLog))
check('the call log is bounded', engine.rpcLog.length <= 40, String(engine.rpcLog.length))

await fs.rm(sandbox, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
