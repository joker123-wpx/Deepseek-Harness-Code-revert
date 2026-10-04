/**
 * Session-log format checks, shared by the plugin and the repair tool.
 *
 * `session.append(...)` validates far less than the on-disk loader. It accepted a
 * synthetic `system/message` appended between turns, while the loader requires
 * every step-scoped event to sit inside a matching OPEN turn and step — so the
 * session became unloadable:
 *
 *   stored session "…" is corrupt: SessionFormatError:
 *   system/message does not match an open turn and step
 *
 * The rules here mirror that loader (`Relationships.requireStep`/`requireTurn`
 * and the surface folding rules), so the plugin can refuse an unsafe append
 * BEFORE it is persisted, and a repair tool can find and drop whatever an older
 * build already wrote.
 *
 * @module dsh-plugin-rewind/logcheck
 */
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** Events the loader requires to name the currently open turn AND step. */
export const STEP_SCOPED = new Set(['system/message', 'assistant/chunk', 'assistant/message', 'tool/call'])

/** Events the loader only requires to be inside some open turn. */
export const TURN_SCOPED = new Set(['request/header', 'request/context', 'todo/write'])

/** The four event types a surface operation may be attached to. */
export const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * Locate the structurally complete Zstandard frames in a concatenated log.
 *
 * @param buffer - the bytes of a `session.v4.jsonl.zstd` artifact.
 * @returns `{ frames, tornStart }`.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (offset > buffer.length) return { frames, tornStart: start }
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decode a concatenated-frame session log into its JSONL text. */
export function decodeLog(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  let text = ''
  for (const frame of frames) text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  return { text, frames: frames.length, tornStart }
}

/** Encode JSONL text as one checksummed Zstandard frame. */
export function encodeLog(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/**
 * Replay the loader's relational state over a list of events.
 *
 * @param events - decoded events in log order.
 * @returns `{ openTurn, openStep, nextTurn, nextStep, protectedHead, surfaceCount }`.
 */
export function replayState(events) {
  let state = {
    openTurn: null,
    openStep: null,
    nextTurn: 1,
    nextStep: 1,
    protectedHead: undefined,
    surfaceCount: 0,
  }
  for (const event of events) state = advance(state, event)
  return state
}

/**
 * Would the loader accept this event in this position?
 *
 * @param state - a {@link replayState} result for the events before the append.
 * @param candidate - `{ type, data, surfaceOp }` about to be appended.
 * @returns `{ ok: true }` or `{ ok: false, reason }` naming the loader's rule.
 */
export function appendIsReloadable(state, candidate) {
  const type = candidate?.type
  const data = candidate?.data ?? {}
  const replacement = candidate?.surfaceOp !== undefined && candidate?.surfaceOp !== 'append'
  const stepScoped = STEP_SCOPED.has(type) || (type === 'tool/result' && !replacement)
  if (type === 'turn/start') {
    if (state.openTurn !== null) return { ok: false, reason: `turn/start while turn ${state.openTurn} is still open` }
    if (data.turn !== state.nextTurn) return { ok: false, reason: `turn/start expected turn ${state.nextTurn}, got ${data.turn}` }
    return { ok: true }
  }
  if (type === 'turn/end') {
    if (state.openTurn !== data.turn) return { ok: false, reason: `turn/end ${data.turn} does not match open turn ${state.openTurn}` }
    if (state.openStep !== null) return { ok: false, reason: `turn/end while step ${state.openStep} is still open` }
    return { ok: true }
  }
  if (type === 'step/start') {
    if (state.openTurn !== data.turn) return { ok: false, reason: `step/start in turn ${data.turn} but open turn is ${state.openTurn}` }
    if (state.openStep !== null) return { ok: false, reason: `step/start ${data.step} while step ${state.openStep} is still open` }
    if (data.step !== state.nextStep) return { ok: false, reason: `step/start expected step ${state.nextStep}, got ${data.step}` }
    return { ok: true }
  }
  if (type === 'step/end') {
    if (state.openTurn !== data.turn || state.openStep !== data.step
      || state.openTurn === null || state.openStep === null) {
      return { ok: false, reason: `step/end names turn ${data.turn}/step ${data.step} but open is ${state.openTurn}/${state.openStep}` }
    }
    return { ok: true }
  }
  if (stepScoped) {
    if (state.openTurn === null || state.openStep === null
      || data.turn !== state.openTurn || data.step !== state.openStep) {
      return {
        ok: false,
        reason: `${type} names turn ${data.turn}/step ${data.step} but open is ${state.openTurn}/${state.openStep}`,
      }
    }
    return { ok: true }
  }
  if (type === 'tool/result' && replacement) {
    if (state.openTurn === null) return { ok: false, reason: 'tool/result surface replacement appended outside any open turn' }
    return { ok: true }
  }
  if (TURN_SCOPED.has(type) && state.openTurn === null) {
    return { ok: false, reason: `${type} appended outside any open turn` }
  }
  if (type === 'system/message' && state.surfaceCount > 0 && state.protectedHead === undefined) {
    return { ok: false, reason: 'system/message requires a protected first surface head' }
  }
  return { ok: true }
}

/**
 * Find every event that the loader would reject, with the rule it breaks.
 *
 * @param events - decoded events in log order.
 * @returns a list of `{ index, seq, kind, detail }`, empty when the log is sound.
 */
export function findInvalidEvents(events) {
  const problems = []
  let state = replayState([])
  for (const [index, event] of events.entries()) {
    if (event?.type === undefined) continue
    const check = appendIsReloadable(state, event)
    const isRewind = event.type === 'system/message'
      && typeof event.data?.message?.id === 'string'
      && event.data.message.id.startsWith('rewind-')
    if (check.ok !== true) {
      problems.push({
        index,
        seq: event.seq,
        kind: isRewind ? 'rewind-outside-turn' : 'invalid',
        detail: check.reason,
        event,
      })
      continue
    }
    state = advance(state, event)
  }
  return problems
}

/** The relational state after one accepted event. */
function advance(state, event) {
  const data = event?.data ?? {}
  const next = { ...state }
  if (SURFACE_TYPES.has(event?.type) && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
    if (next.surfaceCount === 0 && event.type === 'system/message') next.protectedHead = event.seq
    next.surfaceCount += 1
  }
  switch (event?.type) {
    case 'turn/start':
      next.openTurn = data.turn
      next.openStep = null
      next.nextStep = 1
      break
    case 'turn/end':
      next.openTurn = null
      next.openStep = null
      next.nextTurn = state.nextTurn + 1
      break
    case 'step/start':
      next.openStep = data.step
      break
    case 'step/end':
      next.openStep = null
      next.nextStep = state.nextStep + 1
      break
    default:
      break
  }
  return next
}

/**
 * Parse JSONL text into `{ header, events }`, reporting unparseable lines.
 *
 * @param text - the decoded log.
 */
export function parseLog(text) {
  const lines = text.split('\n')
  const events = []
  const badLines = []
  let header
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines.push(index)
      continue
    }
    if (header === undefined && parsed?.type === 'session') {
      header = parsed
      continue
    }
    events.push(parsed)
  }
  return { header, events, badLines, lines }
}

/**
 * Drop the plugin's invalid rewind markers from a decoded log.
 *
 * @param text - decoded JSONL.
 * @returns `{ text, dropped }`, with the rewritten log and the dropped line ids.
 */
export function repairLogText(text) {
  const parsed = parseLog(text)
  const problems = findInvalidEvents(parsed.events)
  const droppable = problems.filter((problem) => problem.kind === 'rewind-outside-turn')
  if (droppable.length === 0) return { text, dropped: [], problems }
  const dropSeqs = new Set(droppable.map((problem) => problem.event.seq))
  const kept = parsed.lines.filter((line) => {
    if (line.trim() === '') return true
    try {
      const event = JSON.parse(line)
      return !(event?.seq !== undefined && dropSeqs.has(event.seq) && event.type !== 'session')
    } catch {
      return true
    }
  })
  return { text: kept.join('\n'), dropped: [...dropSeqs], problems }
}
