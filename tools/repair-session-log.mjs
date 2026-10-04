/**
 * Repair session logs that dsh-plugin-rewind corrupted.
 *
 * The plugin's in-place rewind appended a synthetic `system/message` carrying a
 * `surfaceOp: { op: 'replace' }` at a turn boundary. That event type is
 * turn/step-scoped in the session format — the loader requires
 * `data.turn`/`data.step` to match an OPEN turn and step — so an event appended
 * while no turn is open makes the whole session unloadable:
 *
 *   stored session "…" is corrupt: SessionFormatError:
 *   system/message does not match an open turn and step
 *
 * The repair drops exactly those events (identified by the `rewind-` message id
 * the plugin stamps on them, plus a turn/step check) and rewrites the log. The
 * workspace files are untouched: a rewind's file effect is separate, so a
 * repaired session keeps the rollback it already applied and only loses the
 * history rewrite.
 *
 * Usage:
 *   node tools/repair-session-log.mjs                 # report every session
 *   node tools/repair-session-log.mjs --apply         # repair what it reports
 *   node tools/repair-session-log.mjs --apply <file>  # repair one log
 *
 * @module dsh-plugin-rewind/tools/repair-session-log
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? 'C:/Users/Administrator/.dsh/sessions'
const LOG_NAME = 'session.v4.jsonl.zstd'

/** Locate the structurally complete Zstandard frames inside a concatenated log. */
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
 * Find the plugin's invalid rewind events in a decoded log.
 *
 * A rewind event is invalid when it is a `system/message` whose message id
 * starts with `rewind-` and which is not appended inside a matching open
 * turn/step — the exact shape that makes the loader refuse the session.
 */
export function findInvalidEvents(text) {
  const lines = text.split('\n')
  const problems = []
  let openTurn = null
  let openStep = null
  let nextTurn = 1
  let nextStep = 1
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      problems.push({ index, seq: undefined, kind: 'unparseable', detail: line.slice(0, 80) })
      continue
    }
    const type = event.type
    const data = event.data ?? {}
    if (type === undefined) continue
    if (type === 'turn/start') {
      openTurn = data.turn
      nextStep = 1
      continue
    }
    if (type === 'turn/end') {
      openTurn = null
      openStep = null
      nextTurn += 1
      continue
    }
    if (type === 'step/start') {
      openStep = data.step
      continue
    }
    if (type === 'step/end') {
      openStep = null
      nextStep += 1
      continue
    }
    const isRewind = type === 'system/message'
      && typeof data?.message?.id === 'string'
      && data.message.id.startsWith('rewind-')
    if (isRewind) {
      problems.push({
        index,
        seq: event.seq,
        kind: openTurn === null || openStep === null ? 'rewind-outside-turn' : 'rewind-inside-turn',
        detail: `data.turn=${data.turn} data.step=${data.step} open=${openTurn}/${openStep} replace=${data?.surfaceOp?.startSeq}..${data?.surfaceOp?.endSeq}`,
        line,
      })
      continue
    }
    // The same rules the loader applies, split by what each event declares:
    // step-scoped events must name the open turn AND step; turn-scoped events
    // (`request/header`, `request/context`, `todo/write`) only need an open turn.
    const STEP_SCOPED = ['system/message', 'assistant/chunk', 'assistant/message', 'tool/call']
    const TURN_SCOPED = ['request/header', 'request/context', 'todo/write']
    const turn = event.data?.turn
    const step = event.data?.step
    if (STEP_SCOPED.includes(type)) {
      if (openTurn === null || openStep === null || turn !== openTurn || step !== openStep) {
        problems.push({
          index,
          seq: event.seq,
          kind: 'step-mismatch',
          detail: `${type} names turn ${turn}/step ${step} but open is ${openTurn}/${openStep}`,
          line,
        })
      }
    } else if (TURN_SCOPED.includes(type)) {
      if (openTurn === null) {
        problems.push({
          index,
          seq: event.seq,
          kind: 'turn-mismatch',
          detail: `${type} appended outside any open turn`,
          line,
        })
      }
    }
    if (type === 'session/end-seed') continue
  }
  return problems
}

/** Repair one decoded log: drop the invalid events that carry a rewind marker. */
export function repairLog(text) {
  const problems = findInvalidEvents(text)
  const droppable = new Set(problems
    .filter((problem) => problem.kind === 'rewind-outside-turn')
    .map((problem) => problem.index))
  if (droppable.size === 0) return { text, dropped: [], problems }
  const lines = text.split('\n')
  const kept = lines.filter((line, index) => !(droppable.has(index) && line.trim() !== ''))
  return { text: kept.join('\n'), dropped: [...droppable], problems }
}

/** Every session log under a sessions root. */
function logsUnder(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const workspace of readdirSync(root)) {
    const workspacePath = join(root, workspace)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const session of readdirSync(workspacePath)) {
      const log = join(workspacePath, session, LOG_NAME)
      if (existsSync(log)) found.push(log)
    }
  }
  return found
}

/** Inspect (and optionally repair) one log file. */
function processLog(path, apply) {
  const buffer = readFileSync(path)
  const { text, frames, tornStart } = decodeLog(buffer)
  const problems = findInvalidEvents(text)
  const fatal = problems.filter((problem) => problem.kind !== 'rewind-inside-turn')
  const label = `${basename(dirname(path))}`
  if (fatal.length === 0) {
    console.log(`OK    ${label}  (${frames} frames, ${problems.length} rewind marker(s), all valid)`)
    return { path, repaired: false }
  }
  console.log(`BROKEN ${label}  ${fatal.length} invalid event(s), tornStart=${tornStart ?? 'none'}`)
  for (const problem of fatal) {
    console.log(`        line ${problem.index} seq ${problem.seq} ${problem.kind}: ${problem.detail}`)
  }
  const { text: repaired, dropped } = repairLog(text)
  const stillBroken = findInvalidEvents(repaired).filter((problem) => problem.kind !== 'rewind-inside-turn')
  console.log(`        would drop line(s) ${dropped.join(', ')} -> ${stillBroken.length === 0 ? 'log becomes valid' : `${stillBroken.length} problem(s) left`}`)
  if (!apply || stillBroken.length > 0) return { path, repaired: false, wouldRepair: stillBroken.length === 0 }
  // The backup lives beside the log: it is the file a user can find, and it needs
  // no directory this process may not be allowed to create.
  const backup = `${path}.pre-repair-${Date.now()}`
  writeFileSync(backup, buffer)
  writeFileSync(path, encodeLog(repaired))
  console.log(`        repaired; backup at ${backup}`)
  return { path, repaired: true, backup }
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const targets = args.filter((arg) => arg !== '--apply')
const logs = targets.length > 0 ? targets : logsUnder(SESSIONS_ROOT)
console.log(`${apply ? 'Repairing' : 'Scanning'} ${logs.length} session log(s) under ${SESSIONS_ROOT}\n`)
let broken = 0
let repaired = 0
for (const log of logs) {
  const result = processLog(log, apply)
  if (result.wouldRepair === true || result.repaired === true) broken += 1
  if (result.repaired === true) repaired += 1
}
console.log(`\n${broken} log(s) needed repair, ${repaired} repaired${apply ? '' : ' (re-run with --apply)'}`)
