/**
 * Log-format probe: the rule that made one session unloadable.
 *
 * The incident's log contained this event, appended while no turn was open:
 *
 *   {"type":"system/message","seq":108,…,"data":{"turn":3,"step":7,
 *    "message":{"id":"rewind-…","role":"system","content":[]}},
 *    "surfaceOp":{"op":"replace","startSeq":37,"endSeq":103}}
 *
 * `session.append` accepted it; the loader that reopens a stored session does not
 * ("system/message does not match an open turn and step"), and it rejected the
 * whole file. These checks pin the guard that now refuses such a write, the
 * checker that finds one already written, and the repair that drops it.
 *
 * Run: node test/logcheck.probe.mjs
 */
import { appendIsReloadable, findInvalidEvents, parseLog, repairLogText, replayState } from '../lib/logcheck.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}  ${detail ?? ''}`)
  }
}

/** The marker exactly as the incident's log carried it. */
const marker = (turn, step) => ({
  type: 'system/message',
  seq: 108,
  data: {
    turn,
    step,
    message: { id: 'rewind-4061b6a9', role: 'system', source: { kind: 'system-prompt' }, content: [] },
  },
  surfaceOp: { op: 'replace', startSeq: 37, endSeq: 103 },
})

/** A three-turn conversation whose last turn is closed. */
function closedTurns() {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= 3; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({ type: 'user/message', seq: seq++, data: { turn, step: 1, message: { id: `u${turn}` } } })
    events.push({ type: 'step/start', seq: seq++, data: { turn, step: 1 } })
    events.push({ type: 'assistant/message', seq: seq++, data: { turn, step: 1, message: { id: `a${turn}` } } })
    events.push({ type: 'step/end', seq: seq++, data: { turn, step: 1 } })
    events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

const closed = closedTurns()
const stateAfterTurns = replayState(closed)
check('three closed turns leave no open turn or step',
  stateAfterTurns.openTurn === null && stateAfterTurns.openStep === null
  && stateAfterTurns.nextTurn === 4
  // The loader only resets the step counter on turn/start, so after three closed
  // turns the next step inside a *newly opened* turn is 1 again.
  && stateAfterTurns.nextStep === 2,
  JSON.stringify(stateAfterTurns))

// ── the guard: exactly the incident's append is refused ─────────────────────
const refusal = appendIsReloadable(stateAfterTurns, marker(3, 7))
check('the incident marker is refused before it is written',
  refusal.ok === false && refusal.reason.includes('does not match an open turn and step') === false
  && /names turn 3\/step 7 but open is null\/null/.test(refusal.reason),
  JSON.stringify(refusal))
check('a marker naming the open pair would be accepted', appendIsReloadable(
  { openTurn: 4, openStep: 1, nextTurn: 4, nextStep: 1, surfaceCount: 1, protectedHead: 0 },
  marker(4, 1),
).ok === true)

// ── the checker: find it in a log that already carries it ──────────────────
const brokenEvents = [...closed, { ...marker(3, 7), seq: 18 }]
const problems = findInvalidEvents(brokenEvents)
check('the checker finds the incident event and names the rule',
  problems.length === 1 && problems[0].kind === 'rewind-outside-turn'
  && problems[0].seq === 18,
  JSON.stringify(problems.map((problem) => [problem.seq, problem.kind, problem.detail])))
check('a sound log reports nothing', findInvalidEvents(closed).length === 0,
  JSON.stringify(findInvalidEvents(closed).map((problem) => problem.detail)))

// ── more loader rules the guard must not get wrong ─────────────────────────
const state = stateAfterTurns
check('an assistant message outside a turn is refused',
  appendIsReloadable(state, { type: 'assistant/message', data: { turn: 3, step: 1 } }).ok === false)
check('a request/header only needs an open turn',
  appendIsReloadable({ ...state, openTurn: 4 }, { type: 'request/header', data: {} }).ok === true
  && appendIsReloadable(state, { type: 'request/header', data: {} }).ok === false)
check('a user message is legal outside a turn',
  appendIsReloadable(state, { type: 'user/message', data: { content: [] } }).ok === true)
check('a turn/start must use the next turn number',
  appendIsReloadable(state, { type: 'turn/start', data: { turn: 5 } }).ok === false
  && appendIsReloadable(state, { type: 'turn/start', data: { turn: 4 } }).ok === true)
check('a turn/start is refused while a turn is open',
  appendIsReloadable({ ...state, openTurn: 4 }, { type: 'turn/start', data: { turn: 5 } }).ok === false)
check('a step/start must match the open turn and the next step',
  appendIsReloadable({ ...state, openTurn: 4 }, { type: 'step/start', data: { turn: 4, step: 2 } }).ok === true
  && appendIsReloadable({ ...state, openTurn: 4 }, { type: 'step/start', data: { turn: 4, step: 3 } }).ok === false
  && appendIsReloadable({ ...state, openTurn: 4 }, { type: 'step/start', data: { turn: 5, step: 2 } }).ok === false)
check('a tool/result replacement needs an open turn',
  appendIsReloadable(state, { type: 'tool/result', data: {}, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }).ok === false)

// ── the repair: dropping it leaves a loadable log ──────────────────────────
const text = [
  JSON.stringify({ type: 'session', version: 4, id: 'probe' }),
  ...closed.map((event) => JSON.stringify(event)),
  JSON.stringify({ ...marker(3, 7), seq: 18 }),
].join('\n')
const repaired = repairLogText(text)
check('the repair drops exactly the incident event',
  repaired.dropped.length === 1 && repaired.dropped[0] === 18,
  JSON.stringify(repaired.dropped))
const reparsed = parseLog(repaired.text)
check('the repaired log has no invalid events',
  findInvalidEvents(reparsed.events).length === 0
  && reparsed.events.length === closed.length,
  `${reparsed.events.length} events, ${findInvalidEvents(reparsed.events).length} problems`)
check('the repaired log keeps its header and increasing sequence numbers',
  reparsed.header?.id === 'probe'
  && reparsed.events.every((event, index) => index === 0 || event.seq > reparsed.events[index - 1].seq))
check('a sound log is left untouched by the repair',
  repairLogText(text.replace(`\n${JSON.stringify({ ...marker(3, 7), seq: 18 })}`, '')).dropped.length === 0)

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exitCode = 1
