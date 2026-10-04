/**
 * Conversation-side operations for dsh-plugin-rewind.
 *
 * A DSH session is an append-only event log plus an ordered *surface*: the
 * subsequence of message-producing events the model actually sees. A surface
 * node may carry `surfaceOp: { op: 'replace', start, end }`, which shadows a
 * contiguous range of existing surface nodes. `dsh-session` documents that as a
 * general producer contract ("Used by compaction; any surface-replacing
 * producer may use it"), so a rewind is a supported append rather than file
 * surgery: nothing is ever deleted, the abandoned tail stays in the log, and an
 * independent `foldSurface` replay reproduces the result exactly.
 *
 * This module is pure with respect to disk: it reads an in-memory `Session` and
 * appends events to it.
 *
 * @module dsh-plugin-rewind/conversation
 */
import { randomUUID } from 'node:crypto'

import { appendIsReloadable, replayState, SURFACE_TYPES } from './logcheck.js'

/**
 * Read a session's append-only log across `dsh-session` API revisions.
 *
 * The harness module and a profile's module tree can be different releases:
 * the desktop app in this deployment runs 0.2.0-rc.2, where the log is exposed
 * by `snapshotEvents()`, while 0.1.0-rc.7 exposes it as an `events` getter.
 * Reading through this helper keeps the plugin working on either.
 *
 * @param session - a live Session, or a store entry wrapping one.
 * @returns the frozen event array.
 * @throws when the object carries no readable event log.
 */
export function readSessionEvents(session) {
  if (Array.isArray(session)) return session
  for (const candidate of [session, session?.session]) {
    if (candidate === undefined || candidate === null) continue
    if (typeof candidate.snapshotEvents === 'function') {
      const events = candidate.snapshotEvents()
      if (Array.isArray(events)) return events
    }
    if (Array.isArray(candidate.events)) return candidate.events
  }
  const keys = session === undefined ? 'undefined' : Object.keys(session).slice(0, 12).join(',')
  const error = new Error(`rewind: cannot read a session event log from this object (keys: ${keys})`)
  error.code = 'session-unreadable'
  throw error
}

/** Read the model-visible surface node seqs. */
export function readSurfaceNodes(session) {
  for (const candidate of [session, session?.session]) {
    const nodes = candidate?.surface?.nodes
    if (Array.isArray(nodes)) return [...nodes]
  }
  return []
}

/** The seq range of a surface replacement, in either dialect. */
export function readReplaceRange(op) {
  const start = typeof op?.startSeq === 'number' ? op.startSeq : op?.start
  const end = typeof op?.endSeq === 'number' ? op.endSeq : op?.end
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined
}

/**
 * Classify who produced a surface replacement.
 *
 * The only reliable marker for this plugin's own rewind is the message id it
 * mints (`rewind-…`): its markers are empty-content nodes, and 0.2.x uses
 * empty-content `system/message` nodes for its own purposes too — the running
 * harness delivers the system prompt *in history* and replaces that node
 * whenever the prompt changes. Classifying by type alone therefore reports a
 * prompt update as "you rewound this", which is exactly the mislabel a user
 * saw. Everything is keyed on the id.
 *
 * - `rewind`      — this plugin's marker (`rewind-` id, empty content).
 * - `compaction`  — a `user/message` whose source plugin is `compact`.
 * - `prompt`      — the harness replacing its in-history system/developer node.
 * - `other`       — any other producer, reported as such.
 */
export function classifyReplacement(event) {
  const message = event?.data?.message ?? event?.data
  const id = typeof message?.id === 'string' ? message.id : ''
  const content = Array.isArray(message?.content) ? message.content : undefined
  if (id.startsWith('rewind-') && content?.length === 0) return 'rewind'
  if (event?.type === 'user/message' && event?.data?.source?.plugin === 'compact') return 'compaction'
  if (event?.type === 'system/message' || event?.type === 'developer/message') return 'prompt'
  return 'other'
}

/**
 * Replay a session's surface so a rewind can be told apart from a prompt
 * update, a compaction, or another producer.
 *
 * Every surface-eligible event carries a `surfaceOp` marker and no other event
 * may, so the fold needs no per-version type table. A replacement takes the
 * position of the range it shadows and leaves every LATER node in place — a
 * mid-surface replacement (a prompt update) must not truncate the tail, which
 * is what an off-by-one splice here used to do.
 *
 * @param events - the session log.
 * @returns the current node seqs plus every replacement, classified.
 */
export function foldSessionSurface(events) {
  let nodes = []
  const replacements = []
  for (const event of events) {
    const op = event?.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    const range = readReplaceRange(op)
    if (range === undefined) continue
    const from = nodes.indexOf(range.start)
    const to = nodes.indexOf(range.end)
    if (from === -1 || to === -1 || from > to) continue
    replacements.push({
      seq: event.seq,
      start: range.start,
      end: range.end,
      shadowed: nodes.slice(from, to + 1),
      kind: classifyReplacement(event),
    })
    nodes = [...nodes.slice(0, from), event.seq, ...nodes.slice(to + 1)]
  }
  return { nodes, replacements }
}

/** How many leading events a fork inherited from its parent. */
export function inheritedEventCountOf(session) {
  const header = session?.header ?? {}
  if (typeof session?.inheritedEventCount === 'number') return session.inheritedEventCount
  if (typeof header.inheritedEventCount === 'number') return header.inheritedEventCount
  if (typeof header.seedLength === 'number') return header.seedLength
  return 0
}

/**
 * Build the surface replacement operation in the dialect this session speaks.
 *
 * 0.1.x: `{ op: 'replace', start, end }`.
 * 0.2.x: `{ op: 'replace', startSeq, endSeq }` — the validator there checks the
 * exact key set, so no extra field may ride along.
 */
export function surfaceReplaceOp(session, start, end) {
  const modern = typeof session?.snapshotEvents === 'function'
  return modern ? { op: 'replace', startSeq: start, endSeq: end } : { op: 'replace', start, end }
}

/**
 * The full append intents for a message-less surface replacement, best dialect
 * first, each as a factory so a retry never reuses a snapshotted payload.
 *
 * The two releases disagree in two ways that both matter:
 *
 * - **Range spelling.** 0.1.x uses `{ op: 'replace', start, end }`; 0.2.x uses
 *   `{ op: 'replace', startSeq, endSeq }` and rejects any other key set.
 * - **Which event may carry the marker.** 0.1.x surface types are only
 *   `user/message | assistant/message | tool/result`, so the marker is an empty
 *   `assistant/message`. 0.2.x also admits `system/message` and
 *   `developer/message`, but explicitly forbids `sourceEventSeqs` on an
 *   `assistant/message` ("assistant/message embeds its source stream") while
 *   still requiring `sourceEventSeqs` to cover every shadowed node. An empty
 *   `system/message` satisfies both: it may cite, and an empty content array
 *   projects to no message in either release.
 */
export function surfaceIntents(session, plan, route, open) {
  // A marker must name the OPEN turn and step to be loadable again, and the only
  // moment this plugin has one open is while the agent runs its own rewind tool
  // inside its turn. Without an open pair the plan's next coordinates are used,
  // and applyRewind then refuses the write (see lib/logcheck.js).
  const turn = open?.openTurn ?? plan.analysis?.lastTurn ?? 0
  const step = open?.openStep ?? (plan.analysis?.lastStep ?? 0) + 1
  const modern = () => ({
    dialect: '0.2.x',
    type: 'system/message',
    data: {
      turn,
      step,
      message: {
        id: `rewind-${randomUUID()}`,
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [],
      },
    },
    opts: {
      surfaceOp: { op: 'replace', startSeq: plan.start, endSeq: plan.end },
      sourceEventSeqs: plan.shadowed,
    },
  })
  const legacy = () => ({
    dialect: '0.1.x',
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        id: `rewind-${randomUUID()}`,
        role: 'assistant',
        source: { kind: 'model', provider: route.provider, model: route.model },
        content: [],
      },
    },
    opts: {
      surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
      sourceEventSeqs: plan.shadowed,
    },
  })
  // Which candidates to offer, best first.
  //
  // The legacy `assistant/message` carrier is ONLY for a genuinely old session. A
  // 0.2.x validator rejects it outright — "session event "assistant/message" carries
  // an invalid replace surfaceOp" — and offering it as a second candidate meant a
  // queued rewind could pick it after the modern one was refused, then fail and
  // report exactly that error. A modern session gets the modern carrier only.
  const modernSession = typeof session?.snapshotEvents === 'function'
  return modernSession ? [modern] : [legacy, modern]
}

/** Whether an append rejection is a replacement-metadata problem worth retrying. */
function isMetadataRejection(error) {
  return /surfaceOp|surface replace|shadowed|sourceEventSeqs/i.test(String(error?.message ?? error))
}

/** Flatten one message's content blocks into plain text. */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'reasoning' && typeof block.text === 'string') continue
    else if (typeof block?.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Shorten a prompt for a tree node label. */
export function shorten(text, limit = 48) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/**
 * Read a session's turn structure and surface state.
 *
 * @param session - a live `Session`.
 * @returns turns (with their user prompt, seqs, and surfaced flag), the surface
 *   node list, and the abandoned (shadowed) user-message seqs.
 */
export function analyzeSession(session) {
  const events = readSessionEvents(session)
  const surfaceNodes = readSurfaceNodes(session)
  const surfaced = new Set(surfaceNodes)
  const turns = []
  let current = undefined
  let lastTurn = 0
  let lastStep = 0

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        current = {
          turn: event.data.turn,
          startSeq: event.seq,
          endSeq: undefined,
          userSeq: undefined,
          userId: undefined,
          prompt: '',
          promptTime: undefined,
          stepCount: 0,
          toolCalls: 0,
          // When the turn opened, so the row can report how long it took.
          startedAt: event.time,
          durationMs: undefined,
          usage: undefined,
          model: undefined,
        }
        turns.push(current)
        lastTurn = Math.max(lastTurn, event.data.turn)
        break
      }
      case 'step/start': {
        if (current !== undefined && event.data.turn === current.turn) current.stepCount += 1
        lastStep = Math.max(lastStep, event.data.step)
        break
      }
      case 'assistant/message': {
        // Token usage rides each model answer (`data.usage`), so a turn's totals
        // are the sum over its steps. That is what a row reports.
        const usage = event.data?.usage
        if (current !== undefined && usage !== undefined) {
          const slot = current.usage ?? {
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
          }
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
            slot[key] += Number(usage[key] ?? 0)
          }
          current.usage = slot
        }
        if (current !== undefined && typeof event.data?.model === 'string') current.model = event.data.model
        break
      }
      case 'user/message': {
        const source = event.data?.source
        const isHuman = source?.kind === 'user'
        if (current !== undefined && isHuman && current.userSeq === undefined) {
          current.userSeq = event.seq
          current.userId = event.data.id
          current.prompt = messageText(event.data)
          current.promptTime = event.time
        }
        break
      }
      case 'tool/call': {
        if (current !== undefined) current.toolCalls += 1
        break
      }
      case 'turn/end': {
        if (current !== undefined && event.data.turn === current.turn) {
          current.endSeq = event.seq
          if (typeof current.startedAt === 'number' && typeof event.time === 'number') {
            current.durationMs = Math.max(0, event.time - current.startedAt)
          }
        }
        current = undefined
        break
      }
      default:
        break
    }
  }

  const rewound = new Set()
  const compacted = new Set()
  const promptReplaced = new Set()
  const otherwiseReplaced = new Set()
  const fold = foldSessionSurface(events)
  for (const replacement of fold.replacements) {
    const target = replacement.kind === 'rewind'
      ? rewound
      : replacement.kind === 'compaction'
        ? compacted
        : replacement.kind === 'prompt' ? promptReplaced : otherwiseReplaced
    for (const seq of replacement.shadowed) target.add(seq)
  }

  for (const turn of turns) {
    // A turn with no human prompt is an auto-continued round (a goal round, a
    // steer): there is nothing to rewind TO, and its absence from the surface is
    // not a removal. `fold` is the authority for who removed a real prompt.
    turn.hasPrompt = turn.userSeq !== undefined
    turn.surfaced = !turn.hasPrompt || surfaced.has(turn.userSeq)
    turn.rewound = turn.hasPrompt && rewound.has(turn.userSeq)
    turn.compacted = turn.hasPrompt && compacted.has(turn.userSeq)
    turn.promptReplaced = turn.hasPrompt && promptReplaced.has(turn.userSeq)
    turn.replacedByOther = turn.hasPrompt && otherwiseReplaced.has(turn.userSeq)
  }

  const abandoned = turns.filter((turn) => turn.hasPrompt && !turn.surfaced)
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  return {
    turns,
    surfaceNodes,
    lastTurn,
    lastStep,
    abandonedSeqs: abandoned.map((turn) => turn.userSeq),
    // One entry per conversation rewind: the turns it folded away, as turn numbers.
    // The panel draws each of these as its OWN branch, so several rewinds in one
    // conversation read as 2-7 / 8 9 / 10-15 / 16 instead of one lumped run.
    rewinds: fold.replacements
      .filter((replacement) => replacement.kind === 'rewind')
      .map((replacement) => {
        const shadowed = new Set(replacement.shadowed)
        const cut = turns
          .filter((turn) => turn.userSeq !== undefined && shadowed.has(turn.userSeq))
          .map((turn) => turn.turn)
        return { start: replacement.start, end: replacement.end, turns: cut }
      })
      .filter((rewind) => rewind.turns.length > 0)
      .map((rewind, index) => ({
        index,
        // The rewind TARGET's own turn is shadowed by the replacement (its prompt must
        // not be silently re-asked), but the row the user picked is still the anchor the
        // new branch connects from and the panel keeps it live. Greying it made "rewind
        // to 34" show 34 as history, so the range starts one turn after the target.
        fromTurn: Math.min(...rewind.turns) + 1,
        toTurn: Math.max(...rewind.turns),
        count: Math.max(0, rewind.turns.length - 1),
      }))
      .filter((rewind) => rewind.count > 0),
    rewoundSeqs: [...rewound],
    compactedSeqs: [...compacted],
    promptReplacedSeqs: [...promptReplaced],
    replacements: fold.replacements.map((replacement) => ({
      seq: replacement.seq,
      start: replacement.start,
      end: replacement.end,
      kind: replacement.kind,
      shadowed: replacement.shadowed.length,
    })),
    messageCount: messages.length,
  }
}

/** Last surfaced turn, which is the branch the model is currently on. */
export function activeTurns(analysis) {
  return analysis.turns.filter((turn) => turn.surfaced)
}

/**
 * Describe what a rewind to one turn would do, without changing anything.
 *
 * @param session - a live `Session`.
 * @param targetUserSeq - seq of the `user/message` event to rewind to.
 * @returns a plan, or `{ ok: false, reason }` when the target is unreachable.
 */
export function planRewind(session, targetUserSeq) {
  const analysis = analyzeSession(session)
  const target = analysis.turns.find((turn) => turn.userSeq === targetUserSeq)
  if (target === undefined) {
    return { ok: false, reason: 'unknown-target', message: 'no turn carries that message sequence' }
  }
  if (!target.surfaced) {
    return { ok: false, reason: 'already-rewound', message: 'that turn has already left the model-visible history' }
  }
  const nodes = analysis.surfaceNodes
  const tail = nodes.filter((seq) => seq >= targetUserSeq)
  if (tail.length === 0) {
    return { ok: false, reason: 'empty-tail', message: 'the target is not on the current surface' }
  }
  const lastNode = tail[tail.length - 1]
  if (tail.length === 1 && tail[0] === targetUserSeq) {
    return { ok: false, reason: 'tail-is-target', message: 'only the target message remains; nothing to rewind' }
  }
  // `sourceEventSeqs` must name EVERY surface node the replacement shadows — not the
  // folded-away subset. After earlier rewinds the range also contains nodes that were
  // already shadowed, and the 0.2.x validator counts those too:
  //
  //   surface replace: sourceEventSeqs must include every shadowed surface node;
  //   missing 8, 9, 10, ...
  //
  // So the list is taken from the raw log: every surface-typed event whose seq falls
  // inside the replaced range — INCLUDING earlier markers, which are surface nodes too
  // and are exactly what a second rewind over the same tail has to cite. `tail` (the
  // live surface nodes) stays as the plan's own view of what the model saw, which is
  // what the counts and the re-ask anchor use.
  const rangeStart = tail[0]
  const rangeEnd = tail[tail.length - 1]
  const shadowedInRange = readSessionEvents(session)
    .filter((event) => typeof event?.seq === 'number'
      && event.seq >= rangeStart && event.seq <= rangeEnd
      && SURFACE_TYPES.has(event.type))
    .map((event) => event.seq)
  const droppedTurns = analysis.turns.filter((turn) => turn.surfaced && turn.userSeq !== undefined && turn.userSeq >= targetUserSeq)
  return {
    ok: true,
    targetSeq: targetUserSeq,
    targetTurn: target.turn,
    start: rangeStart,
    end: rangeEnd,
    shadowed: shadowedInRange.length > 0 ? shadowedInRange : tail,
    surfaceNodes: tail,
    droppedTurns: droppedTurns.map((turn) => ({ turn: turn.turn, seq: turn.userSeq, prompt: shorten(turn.prompt, 80) })),
    analysis,
  }
}

/**
 * Resolve the provider/model pair recorded for a marker event.
 *
 * A replacement node must survive the session's own replay validation, which
 * requires every `assistant/message` to carry an identified message with a
 * `kind: 'model'` source holding a non-empty provider/model pair. Reusing the
 * session's own resolved route keeps the durable event honest; the marker pair
 * is only a fallback for a session that never logged a request.
 */
function routeOf(session) {
  try {
    const context = session.requestContext?.()
    if (typeof context?.provider === 'string' && context.provider !== ''
      && typeof context?.model === 'string' && context.model !== '') {
      return { provider: context.provider, model: context.model }
    }
    const config = session.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && config.provider !== ''
      && typeof config?.model === 'string' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    /* fall through to the marker pair */
  }
  return { provider: 'dsh-plugin-rewind', model: 'history-marker' }
}

/**
 * Apply an in-place rewind: shadow the surface tail from the target's message
 * onward with one message-less assistant node.
 *
 * The result is that the model-visible history ends immediately before the
 * target turn, while the log keeps every abandoned event. Because the node
 * projects to no message (`deriveEventMessage` returns null for an empty
 * content array), the target prompt is not silently re-asked: the user decides
 * what to send next.
 *
 * The node is shaped exactly like a real assistant message — an id and a
 * `kind: 'model'` source with a provider/model pair — because the session's
 * replay validator requires those fields on every seeded `assistant/message`;
 * an ad-hoc `{ role, content: [] }` would load fine in this process and then
 * refuse to reload from disk.
 *
 * @param session - a live `Session`.
 * @param plan - a plan from {@link planRewind}.
 * @returns the appended event.
 */
export function applyRewind(session, plan) {
  if (plan?.ok !== true) throw new Error(`cannot apply an unusable rewind plan: ${plan?.reason ?? 'unknown'}`)
  const route = routeOf(session)
  const events = readSessionEvents(session)
  const state = replayState(events)
  const intents = surfaceIntents(session, plan, route, state)
  // `session.append` checks far less than the loader that reads this log back:
  // it accepted our replacement between turns, and that single event made the
  // whole session unloadable ("system/message does not match an open turn and
  // step"). Every candidate is therefore replayed through the loader's rules
  // BEFORE anything is written, and an unsafe one is refused, not persisted.
  let lastError
  for (const makeIntent of intents) {
    const intent = makeIntent()
    const check = appendIsReloadable(state, {
      type: intent.type,
      data: intent.data,
      surfaceOp: intent.opts?.surfaceOp,
    })
    if (check.ok !== true) {
      lastError = new RewindUnsafeAppendError(check.reason, intent)
      continue
    }
    try {
      return session.append(intent.type, intent.data, intent.opts)
    } catch (error) {
      lastError = error
      // `append` validates before it mutates, so retrying the other dialect
      // cannot double-append. Only a replacement-metadata rejection is retried;
      // anything else is real and must surface.
      if (!isMetadataRejection(error)) throw error
    }
  }
  throw lastError
}

/**
 * The append this plugin wants is not one the session log can be reloaded from.
 *
 * Raised instead of writing, so an unsupported rewind reports itself rather than
 * corrupting a conversation that then refuses to load.
 */
export class RewindUnsafeAppendError extends Error {
  constructor(reason, intent) {
    super(`refusing to write a rewind marker the session log could not be reloaded from: ${reason}`)
    this.name = 'RewindUnsafeAppendError'
    this.code = 'unsafe-append'
    this.reason = reason
    this.carrier = intent?.type
  }
}

/**
 * Which turns a rewind to this checkpoint's turn would abandon, for the UI's
 * confirmation dialog.
 */
export function rewindPreview(session, targetUserSeq) {
  const plan = planRewind(session, targetUserSeq)
  if (plan.ok !== true) return plan
  return {
    ok: true,
    targetTurn: plan.targetTurn,
    droppedTurns: plan.droppedTurns,
    shadowedNodes: plan.shadowed.length,
  }
}
