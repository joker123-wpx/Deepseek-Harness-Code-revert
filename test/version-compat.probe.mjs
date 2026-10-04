/**
 * Version-compatibility test for the two `dsh-session` API dialects this plugin
 * has to speak at once.
 *
 * The running harness and a profile's module tree can be different releases.
 * In this deployment the desktop app runs `@deepseek-ai/dsh-session`
 * 0.2.0-rc.2 (log read through `snapshotEvents()`, surface replacement spelled
 * `{ op: 'replace', startSeq, endSeq }`, fork prefix on
 * `session.inheritedEventCount`), while the profile's junction resolves
 * 0.1.0-rc.7 (log read through an `events` getter, replacement spelled
 * `{ op: 'replace', start, end }`, fork prefix in `header.seedLength`). Reading
 * only the wrong one produced a live `events is not iterable` failure, so both
 * are covered here with session doubles and one real-session pass.
 *
 * Run: node test/version-compat.probe.mjs
 */
import { applyRewind, analyzeSession, inheritedEventCountOf, planRewind, readSessionEvents, surfaceReplaceOp } from '../lib/conversation.js'

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
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'text', text }],
})

/** Build a session double with the requested API dialect. */
function makeSession({ dialect, seedLength = 0, parentSession = undefined }) {
  const log = []
  const appended = []
  const push = (event) => {
    event.seq = log.length
    log.push(event)
    return event
  }
  const append = (type, data, opts) => {
    if (type === 'user/message' || type === 'assistant/message' || type === 'system/message') {
      // Reproduce both dialects' replacement validation: a wrong range spelling,
      // a missing shadowed-node citation, a citation on an assistant message
      // (0.2.x), or a `system/message` marker on 0.1.x (not surface-eligible
      // there) all reject before the log changes.
      const op = opts?.surfaceOp
      if (op !== undefined && op !== 'append') {
        const wantsSeq = dialect === '0.2.x'
        if (!wantsSeq && type === 'system/message') {
          throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`)
        }
        const spelledRight = wantsSeq
          ? Object.hasOwn(op, 'startSeq') && Object.hasOwn(op, 'endSeq') && Object.keys(op).length === 3
          : Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end') && Object.keys(op).length === 3
        if (!spelledRight) throw new Error(`session event "${type}" carries an invalid replace surfaceOp`)
        const cited = opts.sourceEventSeqs
        if (wantsSeq && type === 'assistant/message' && cited !== undefined) {
          throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
        }
        if (!Array.isArray(cited) || cited.length === 0) {
          throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node')
        }
      }
    }
    appended.push({ type, data, opts })
    return push({ type, data, seq: log.length, time: Date.now(), surfaceOp: opts?.surfaceOp, sourceEventSeqs: opts?.sourceEventSeqs })
  }
  const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message'])
  const surfaceNodes = () => {
    // Fold the ops the way the real surface manager does: a replacement node
    // takes the position of the range it shadows, even when it derives no
    // message (empty assistant content on either release, empty system content
    // on 0.2.x).
    let nodes = []
    for (const event of log) {
      if (!SURFACE_TYPES.has(event.type)) continue
      const op = event.surfaceOp
      if (op === undefined || op === 'append') {
        nodes.push(event.seq)
        continue
      }
      const start = op.startSeq ?? op.start
      const end = op.endSeq ?? op.end
      const from = nodes.indexOf(start)
      const to = nodes.indexOf(end)
      if (from === -1 || to === -1 || from > to) throw new Error('bad replacement range')
      nodes = [...nodes.slice(0, from), event.seq]
    }
    return nodes
  }
  const turn = (n, prompt) => {
    append('turn/start', { turn: n })
    append('user/message', userMessage(`u${n}`, prompt), { surfaceOp: 'append' })
    append('assistant/message', { turn: n, step: 1, message: assistantMessage(`answer ${n}`) }, { surfaceOp: 'append', sourceEventSeqs: [] })
    append('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  turn(1, '第一轮')
  turn(2, '第二轮')
  turn(3, '第三轮')

  const base = {
    id: 'session-double',
    header: { cwd: 'C:/ws', delegationDepth: 0, createdAt: 1, parentSession },
    __log: log,
    get seq() { return log.length },
    append,
    get surface() { return { nodes: surfaceNodes() } },
    deriveMessages() { return surfaceNodes().map((seq) => log[seq].data.message ?? log[seq].data) },
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    requestHeader: () => undefined,
    seedLengthHeader: seedLength,
    appended,
  }
  if (dialect === '0.2.x') {
    base.snapshotEvents = () => Object.freeze([...log])
    base.inheritedEventCount = seedLength
    if (seedLength > 0) base.header.parentSession = parentSession
  } else {
    base.events = log
    base.header.seedLength = seedLength > 0 ? seedLength : undefined
  }
  return base
}

for (const dialect of ['0.1.x', '0.2.x']) {
  console.log(`\n--- ${dialect} session dialect ---`)
  const session = makeSession({ dialect })
  const analysis = analyzeSession(session)
  check(`${dialect}: the event log is readable`, analysis.turns.length === 3, JSON.stringify(analysis.turns.map((t) => t.turn)))
  check(`${dialect}: prompts are captured`, analysis.turns.map((t) => t.prompt).join('|') === '第一轮|第二轮|第三轮')
  check(`${dialect}: the surface is read`, analysis.surfaceNodes.length === 6, JSON.stringify(analysis.surfaceNodes))
  check(`${dialect}: every turn starts surfaced`, analysis.turns.every((t) => t.surfaced === true))

  const target = analysis.turns[2].userSeq
  const plan = planRewind(session, target)
  check(`${dialect}: the rewind plan is applicable`, plan.ok === true, JSON.stringify(plan.reason ?? ''))
  const op = surfaceReplaceOp(session, plan.start, plan.end)
  check(`${dialect}: the replacement op uses this dialect's field names`,
    dialect === '0.2.x'
      ? (op.startSeq === plan.start && op.endSeq === plan.end && op.start === undefined && Object.keys(op).length === 3)
      : (op.start === plan.start && op.end === plan.end && op.startSeq === undefined && Object.keys(op).length === 3),
    JSON.stringify(op))

  // The marker is only loadable from inside an open turn and step, so the same
  // rule holds in both dialects: refused between turns, written inside one.
  let refusedUnsafe
  try {
    applyRewind(session, plan)
  } catch (error) {
    refusedUnsafe = error
  }
  check(`${dialect}: a rewind between turns is refused as unloadable`,
    refusedUnsafe?.code === 'unsafe-append', String(refusedUnsafe?.code))
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })

  const marker = applyRewind(session, plan)
  check(`${dialect}: the marker uses this dialect's event type`,
    dialect === '0.2.x' ? marker.type === 'system/message' : marker.type === 'assistant/message',
    marker.type)
  check(`${dialect}: the marker carries an identified message and a valid source`,
    typeof marker.data.message.id === 'string'
    && marker.data.message.source.kind === (dialect === '0.2.x' ? 'system-prompt' : 'model'))
  check(`${dialect}: the marker cites every shadowed node`,
    JSON.stringify(marker.sourceEventSeqs) === JSON.stringify(plan.shadowed),
    JSON.stringify(marker.sourceEventSeqs))
  check(`${dialect}: the marker content is empty`,
    Array.isArray(marker.data.message.content) && marker.data.message.content.length === 0)
  check(`${dialect}: the rewind removes the abandoned turn from the surface`,
    session.surface.nodes.length === 5, JSON.stringify(session.surface.nodes))
  check(`${dialect}: exactly one replacement node was appended (no double append)`,
    session.appended.filter((entry) => entry.opts?.surfaceOp !== undefined && entry.opts.surfaceOp !== 'append').length === 1,
    String(session.appended.filter((entry) => entry.opts?.surfaceOp !== undefined && entry.opts.surfaceOp !== 'append').length))
  const after = analyzeSession(session)
  check(`${dialect}: the rewound turn is marked abandoned`,
    after.abandonedSeqs.includes(target), JSON.stringify(after.abandonedSeqs))
}

console.log('\n--- the dialect fallback recovers a mis-detected session ---')
// A session whose detected dialect is wrong: it exposes `events` (0.1.x shape)
// but its validator demands the 0.2.x spelling. Detection alone cannot save it,
// so `applyRewind` must recover on the second attempt.
{
  const session = makeSession({ dialect: '0.2.x' })
  delete session.snapshotEvents
  session.events = session.__log
  const before = session.appended.length
  const analysis = analyzeSession(session)
  const plan = planRewind(session, analysis.turns[2].userSeq)
  // The marker needs an open turn/step to be loadable, as in the agent's own turn.
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  let recovered = true
  let marker
  try {
    marker = applyRewind(session, plan)
  } catch (error) {
    recovered = false
    console.log('   fallback failed:', String(error).slice(0, 120))
  }
  check('a mis-detected dialect still rewinds through the fallback', recovered === true)
  check('the fallback appended exactly one accepted replacement',
    session.appended.length - before === 3 && marker?.surfaceOp?.startSeq !== undefined,
    JSON.stringify(marker?.surfaceOp))
  check('the fallback marker still projects to nothing',
    Array.isArray(marker?.data?.message?.content) && marker.data.message.content.length === 0)
}

console.log('\n--- fork prefix across dialects ---')
const child01 = makeSession({ dialect: '0.1.x', seedLength: 8, parentSession: 'parent-1' })
const child02 = makeSession({ dialect: '0.2.x', seedLength: 8, parentSession: 'parent-1' })
check('0.1.x reads the fork prefix from the header', inheritedEventCountOf(child01) === 8, String(inheritedEventCountOf(child01)))
check('0.2.x reads the fork prefix from the instance', inheritedEventCountOf(child02) === 8, String(inheritedEventCountOf(child02)))
check('a root session reports no inherited prefix', inheritedEventCountOf(makeSession({ dialect: '0.2.x' })) === 0)

console.log('\n--- unreadable input is a descriptive typed error ---')
let unreadable
try {
  readSessionEvents({ store: 'nope' })
} catch (error) {
  unreadable = error
}
check('an object without a log raises session-unreadable',
  unreadable?.code === 'session-unreadable' && unreadable.message.includes('keys:'), String(unreadable?.message))
let tooFar
try {
  analyzeSession(undefined)
} catch (error) {
  tooFar = error
}
check('undefined input raises the same typed error', tooFar?.code === 'session-unreadable', String(tooFar?.message))

console.log('\n--- a real 0.1.x session still works ---')
const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
try {
  const { Session } = await import(pathToFileURL(join(MODULES, '@deepseek-ai/dsh-session/lib/index.js')).href)
  const real = Session.create('session-version-probe', [], {
    version: 0, id: 'session-version-probe', createdAt: Date.now(), cwd: process.cwd(), delegationDepth: 0,
  })
  real.append('turn/start', { turn: 1 })
  real.append('step/start', { turn: 1, step: 1 })
  const user = real.append('user/message', userMessage('u1', '真实会话'), { surfaceOp: 'append' })
  real.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('真实回答') }, { surfaceOp: 'append', sourceEventSeqs: [] })
  real.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const realAnalysis = analyzeSession(real)
  check('the real module is readable through the same helpers', realAnalysis.turns.length === 1 && realAnalysis.turns[0].prompt === '真实会话')
  check('the real module reports the 0.1.x flavor', typeof real.snapshotEvents !== 'function' && Array.isArray(real.events))
  const realPlan = planRewind(real, user.seq)
  // The marker needs an open turn/step to be loadable, as in the agent's own turn.
  real.append('turn/start', { turn: 4 })
  real.append('step/start', { turn: 4, step: 1 })
  const realMarker = applyRewind(real, realPlan)
  check('a real 0.1.x rewind still appends the marker', realMarker.data.message.content.length === 0)
  check('the real session surface shrank', real.surface.nodes.length === 1, JSON.stringify([...real.surface.nodes]))
} catch (error) {
  check('the real module is readable through the same helpers', false, String(error).slice(0, 160))
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
