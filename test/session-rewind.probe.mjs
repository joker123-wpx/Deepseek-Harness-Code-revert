/**
 * Conversation-rewind mechanism test, driven against the REAL
 * `@deepseek-ai/dsh-session` implementation.
 *
 * Two things must hold for a rewind to be safe:
 *   1. the surface replacement really removes the abandoned turns from the
 *      model-visible history while keeping them in the append-only log, and an
 *      independent `foldSurface` replay agrees; and
 *   2. the resulting log still RELOADS — the session's seed/replay validator
 *      requires every `assistant/message` to carry an identified message with a
 *      `kind: 'model'` source, so an ad-hoc `{ role, content: [] }` marker would
 *      work in-process and then refuse to load from disk after a restart.
 *
 * Run: node test/session-rewind.probe.mjs
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeSession, applyRewind, planRewind } from '../lib/conversation.js'

const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const load = (relative) => import(pathToFileURL(join(MODULES, relative)).href)
const { Session } = await load('@deepseek-ai/dsh-session/lib/index.js')
const { foldSurface, deriveEventMessage } = await load('@deepseek-ai/dsh-session/lib/types/surface.js')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/** A realistic assistant message: id + model source are mandatory on replay. */
const assistantMessage = (text) => ({
  id: `msg-${Math.random().toString(36).slice(2, 10)}`,
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  content: [{ type: 'text', text }],
})

const userMessage = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user', rpcId: `rpc-${id}` },
  content: [{ type: 'text', text }],
})

const header = (id) => ({
  version: 0,
  id,
  createdAt: Date.now(),
  cwd: process.cwd(),
  delegationDepth: 0,
  agentPreset: 'standard',
})

const session = Session.create('session-rewind-probe', [], header('session-rewind-probe'))

/** Append one complete turn and return the seqs that entered the surface. */
function appendTurn(turn, promptText, answerText) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', userMessage(`u${turn}`, promptText), { surfaceOp: 'append' })
  session.append('request/context', { provider: 'deepseek-official', model: 'deepseek-flash' })
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text', text: answerText } })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(answerText),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userSeq: user.seq, assistantSeq: assistant.seq }
}

appendTurn(1, '第一轮提问', '第一轮回答')
appendTurn(2, '第二轮提问', '第二轮回答')
const turn3 = appendTurn(3, '第三轮提问', '第三轮回答')

const transcript = () => session.deriveMessages().map((message) => `${message.role}:${message.content?.[0]?.text ?? ''}`)

console.log('--- baseline ---')
console.log('log length      :', session.seq)
console.log('surface nodes   :', JSON.stringify(session.surface.nodes))
console.log('transcript      :', JSON.stringify(transcript()))
check('three turns appended', session.seq >= 18, `seq=${session.seq}`)
check('six surface nodes', session.surface.nodes.length === 6, JSON.stringify(session.surface.nodes))
check('six derived messages', session.deriveMessages().length === 6)

// ── analysis ────────────────────────────────────────────────────────────────
const analysis = analyzeSession(session)
check('analysis finds three turns', analysis.turns.length === 3, JSON.stringify(analysis.turns.map((turn) => turn.turn)))
check('analysis captures each prompt', analysis.turns.map((turn) => turn.prompt).join('|') === '第一轮提问|第二轮提问|第三轮提问')
check('analysis marks every turn as surfaced', analysis.turns.every((turn) => turn.surfaced === true))
check('analysis reads the last turn and step', analysis.lastTurn === 3 && analysis.lastStep === 1)

// ── plan + apply ────────────────────────────────────────────────────────────
const plan = planRewind(session, turn3.userSeq)
check('plan is applicable', plan.ok === true, JSON.stringify(plan.reason ?? ''))
check('plan shadows exactly the target turn', plan.shadowed.length === 2, JSON.stringify(plan.shadowed))
check('plan reports the dropped turn', plan.droppedTurns.length === 1 && plan.droppedTurns[0].turn === 3)

// ── the write is refused between turns, and allowed inside one ──────────────
// The loader only accepts a surface replacement that names an OPEN turn and step.
// A panel-initiated rewind has none open, so writing there is what made a session
// unloadable in the field; the same write inside the agent's own turn is fine.
const before = session.deriveMessages().length
const eventsBefore = session.events.length
let refusedUnsafe
try {
  applyRewind(session, plan)
} catch (error) {
  refusedUnsafe = error
}
check('a rewind between turns is refused as unloadable',
  refusedUnsafe?.code === 'unsafe-append' && session.events.length === eventsBefore,
  JSON.stringify({ code: refusedUnsafe?.code, appended: session.events.length - eventsBefore }))
check('the refusal does not touch the surface',
  session.surface.nodes.length === session.events.length || session.deriveMessages().length === before,
  `${session.deriveMessages().length} vs ${before}`)

// The agent's own rewind tool runs inside its turn: open one and the write lands.
session.append('turn/start', { turn: 4 })
session.append('step/start', { turn: 4, step: 1 })
const marker = applyRewind(session, plan)
const after = session.deriveMessages().length
console.log('marker event    :', JSON.stringify(marker.data).slice(0, 220))
check('the marker names the open turn and step', marker.data.turn === 4 && marker.data.step === 1,
  `${marker.data.turn}/${marker.data.step}`)
check('marker carries an identified message', typeof marker.data.message.id === 'string' && marker.data.message.id !== '')
check('marker carries a model source', marker.data.message.source.kind === 'model'
  && typeof marker.data.message.source.provider === 'string'
  && typeof marker.data.message.source.model === 'string')
check('marker projects to no model message', deriveEventMessage(marker) === null)
check('rewind dropped the abandoned turn from history', after === before - 2, `${before} -> ${after}`)
check('transcript ends at the second turn', transcript().join('|') === 'user:第一轮提问|assistant:第一轮回答|user:第二轮提问|assistant:第二轮回答',
  JSON.stringify(transcript()))
check('abandoned events stay in the log', session.events.some((event) => event.seq === turn3.userSeq))
check('surface is the prefix plus the marker', JSON.stringify(session.surface.nodes) === JSON.stringify([...session.surface.nodes.slice(0, 4), marker.seq]))

// ── independent fold agrees ─────────────────────────────────────────────────
const folded = foldSurface(session.events)
check('foldSurface replay matches the live surface', JSON.stringify(folded.nodes) === JSON.stringify([...session.surface.nodes]))
check('fold records exactly one replacement', folded.replacements.length === 1
  && folded.replacements[0].seq === marker.seq
  && JSON.stringify(folded.replacements[0].shadowedSeqs) === JSON.stringify(plan.shadowed), JSON.stringify(folded.replacements))

// ── replay: the log must still load after a restart ─────────────────────────
let replayError = ''
let replayMessages = -1
try {
  const replayed = Session.create(`${session.id}-replay`, [...session.events], header(`${session.id}-replay`))
  replayMessages = replayed.deriveMessages().length
} catch (error) {
  replayError = String(error?.message ?? error)
}
check('the rewound log reloads through the seed/replay validator', replayError === '', replayError)
check('the reloaded session keeps the rewound history', replayMessages === after, `messages=${replayMessages} expected=${after}`)

// ── a second rewind of the same turn is refused ─────────────────────────────
const second = planRewind(session, turn3.userSeq)
check('rewinding the same turn twice is refused', second.ok === false && second.reason === 'already-rewound', JSON.stringify(second))
const turn2 = analysis.turns[1]
const plan2 = planRewind(session, turn2.userSeq)
check('an earlier turn is still reachable', plan2.ok === true && plan2.targetTurn === 2, JSON.stringify(plan2.reason ?? ''))
applyRewind(session, plan2)
check('rewinding further leaves only the first turn', transcript().join('|') === 'user:第一轮提问|assistant:第一轮回答',
  JSON.stringify(transcript()))
let replayAfterTwo = -1
try {
  replayAfterTwo = Session.create('session-rewind-probe-replay2', [...session.events], header('session-rewind-probe-replay2')).deriveMessages().length
} catch (error) {
  replayAfterTwo = -1
  console.log('replay after two rewinds failed:', String(error))
}
check('two stacked rewinds still reload', replayAfterTwo === 2, `messages=${replayAfterTwo}`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
