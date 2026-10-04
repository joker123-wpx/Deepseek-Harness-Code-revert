/**
 * Run the plugin's session helpers against the `dsh-session` copy the RUNNING
 * desktop app actually loads (inside `app.asar`, 0.2.0-rc.2), not the rc.7 copy
 * a profile resolves.
 *
 * Plain Node cannot read an asar path, so this file must be executed with the
 * bundled Electron binary in Node mode:
 *
 *   $env:DSH_DESKTOP_NODE_EXECUTABLE='D:\Deepseek-Harness\DeepSeek Harness.exe'
 *   D:\Deepseek-Harness\resources\runtime\bin\node.cmd test/running-session.probe.mjs
 *
 * Run: see above (the normal runner skips it, because it needs that binary).
 */
import { pathToFileURL } from 'node:url'
import { applyRewind, analyzeSession, inheritedEventCountOf, planRewind, readSessionEvents, surfaceReplaceOp } from '../lib/conversation.js'

const ASAR = process.env.DSH_ASAR_MODULES
  ?? 'D:/Deepseek-Harness/resources/app.asar/dsh/node_modules'

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

const userMessage = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user', rpcId: `rpc-${id}` },
  content: [{ type: 'text', text }],
})
const assistantMessage = (text) => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`,
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  content: [{ type: 'text', text }],
})

let Session
try {
  ({ Session } = await import(pathToFileURL(`${ASAR}/@deepseek-ai/dsh-session/lib/index.js`).href))
} catch (error) {
  console.log(`cannot import the asar copy of dsh-session: ${String(error).slice(0, 200)}`)
  console.log('this probe must run under the bundled Electron binary in Node mode; skipping.')
  process.exit(0)
}

check('the app copy of dsh-session loaded', typeof Session?.create === 'function')

// The running app stamps header version 4 and requires `isSeeded`.
const header = {
  version: 4,
  id: 'session-running-probe',
  createdAt: Date.now(),
  cwd: process.cwd(),
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
const session = Session.create('session-running-probe', [], header)
check('the running copy exposes snapshotEvents()', typeof session.snapshotEvents === 'function')
check('the running copy has no events getter', session.events === undefined, String(session.events))

const events = readSessionEvents(session)
check('the plugin reads the log through the running API', Array.isArray(events))
check('the plugin detects the 0.2.x replacement dialect',
  JSON.stringify(surfaceReplaceOp(session, 1, 2)) === JSON.stringify({ op: 'replace', startSeq: 1, endSeq: 2 }),
  JSON.stringify(surfaceReplaceOp(session, 1, 2)))

// Three turns on the real implementation.
let lastUserSeq
for (let turn = 1; turn <= 3; turn += 1) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', userMessage(`u${turn}`, `第 ${turn} 轮提问`), { surfaceOp: 'append' })
  session.append('request/context', { provider: 'deepseek-official', model: 'deepseek-flash' })
  // 0.2.x validates assistant settlement fields on replay: `turn`, `step` and
  // an embedded `stream` array (the source stream that replaces the old
  // `sourceEventSeqs` citation).
  session.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(`第 ${turn} 轮回答`),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  lastUserSeq = user.seq
}

const analysis = analyzeSession(session)
check('turn analysis works on the running copy', analysis.turns.length === 3, JSON.stringify(analysis.turns.map((t) => t.turn)))
check('prompts read from the running copy', analysis.turns.map((t) => t.prompt).join('|') === '第 1 轮提问|第 2 轮提问|第 3 轮提问')
check('the surface is read from the running copy', analysis.surfaceNodes.length === 6, JSON.stringify(analysis.surfaceNodes))
check('messages derive on the running copy', analysis.messageCount === 6, String(analysis.messageCount))

const before = session.deriveMessages().length
const plan = planRewind(session, lastUserSeq)
check('the rewind plan is applicable on the running copy', plan.ok === true, JSON.stringify(plan.reason ?? ''))
// Between turns the marker cannot be written safely: the running loader only
// accepts a surface replacement inside an OPEN turn and step. Refusing is the fix
// for the session that became unloadable, so that is what is checked here; the
// write itself is then exercised with a turn open, as the agent's tool has.
let refusedUnsafe
try {
  applyRewind(session, plan)
} catch (error) {
  refusedUnsafe = error
}
check('the running copy refuses a rewind marker written between turns',
  refusedUnsafe?.code === 'unsafe-append', String(refusedUnsafe?.code))
session.append('turn/start', { turn: 4 })
session.append('step/start', { turn: 4, step: 1 })
const marker = applyRewind(session, plan)
const after = session.deriveMessages().length
check('the rewind removed the abandoned turn on the running copy', after === before - 2, `${before} -> ${after}`)
check('the marker was appended in the running dialect',
  marker.surfaceOp?.op === 'replace' && marker.surfaceOp.startSeq === plan.start && marker.surfaceOp.endSeq === plan.end,
  JSON.stringify(marker.surfaceOp))
check('the marker projects to no model message',
  marker.data.message.content.length === 0 && session.deriveEventMessage(marker) === null)

// The decisive check: the rewound log must reload through the running
// implementation's own seed/replay validator.
let replayError = ''
let replayed = -1
try {
  const restored = Session.create('session-running-probe-replay', [...session.snapshotEvents()], {
    ...header,
    id: 'session-running-probe-replay',
  })
  replayed = restored.deriveMessages().length
} catch (error) {
  replayError = String(error?.message ?? error)
}
check('the rewound log reloads on the running implementation', replayError === '', replayError)
check('the reloaded session keeps the rewound history', replayed === after, `messages=${replayed} expected=${after}`)

// A fork's prefix is reported on the instance in this release.
// 0.2.x requires `isSeeded: true` as soon as the inherited count is non-zero.
const forked = Session.create('session-running-fork', [...session.snapshotEvents()], {
  ...header,
  id: 'session-running-fork',
  isSeeded: true,
  parentSession: session.id,
}, session.seq)
check('a fork reports its inherited prefix', inheritedEventCountOf(forked) === session.seq, String(inheritedEventCountOf(forked)))
const ownCount = forked.ownEvents().length
check('a fork separates its own events from the inherited prefix',
  ownCount === forked.snapshotEvents().length - inheritedEventCountOf(forked),
  `own=${ownCount} total=${forked.snapshotEvents().length} inherited=${inheritedEventCountOf(forked)}`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
