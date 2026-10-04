/**
 * Rollback engine for dsh-plugin-rewind.
 *
 * The engine owns three concerns:
 *  1. **Checkpoints** — one per turn boundary, each with a workspace manifest.
 *  2. **Conversation rewind** — surface replacement (in place) or a fork.
 *  3. **Workspace rollback** — restore a manifest into the workspace.
 *
 * It is deliberately transport-free and cordis-free so the whole rollback path
 * can be exercised from a plain Node test with a fake session list.
 *
 * @module dsh-plugin-rewind/engine
 */
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { analyzeSession, applyRewind, inheritedEventCountOf, planRewind, readSessionEvents, shorten } from './conversation.js'
import { RewindStore, manifestFileFor, manifestFilesOf } from './store.js'
import { manifestIndex, restoreWorkspace, snapshotWorkspace } from './workspace.js'

/** Fold one root's restore summary into the multi-root total. */
function addSummary(total, summary) {
  total.restored += summary.restored ?? 0
  total.recreated += summary.recreated ?? 0
  total.deleted += summary.deleted ?? 0
  total.createdDirs += summary.createdDirs ?? 0
  total.removedDirs += summary.removedDirs ?? 0
  total.symlinks += summary.symlinks ?? 0
  total.unchanged += summary.unchanged ?? 0
  for (const failure of summary.failed ?? []) total.failed.push(failure)
  total.plan = total.plan ?? { added: [], changed: [], removed: [] }
  for (const key of ['added', 'changed', 'removed']) {
    for (const rel of summary.plan?.[key] ?? []) total.plan[key].push(rel)
  }
  return total
}

/** Canonical form of a workspace root: absolute, no trailing separator. */
function normalizeRoot(value) {
  const absolute = resolve(String(value))
  return absolute.endsWith(sep) && absolute.length > 1 ? absolute.slice(0, -1) : absolute
}

/** Whether `child` is `parent` or lives inside it. */
function isInside(parent, child) {
  if (parent === child) return true
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/** Whether a path currently resolves to a directory. */
async function isDirectory(path) {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** Error with a stable code the RPC layer can surface. */
export class RewindError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Summarise a manifest for the tree without shipping its file list. */
function manifestStats(manifest) {
  if (manifest === undefined) return undefined
  return {
    files: manifest.files?.length ?? 0,
    bytes: manifest.stats?.bytes ?? 0,
    skipped: manifest.skipped?.length ?? 0,
    truncated: manifest.truncated === true,
  }
}

/** The rollback engine. */
export class RewindEngine {
  /**
   * @param options - `store` (a RewindStore), `config` (plugin configuration),
   *   `sessions` (a live-session lookup, `(id) => Session | undefined`),
   *   `listSessions` (`() => Session[]`), and `logger`.
   */
  constructor(options) {
    this.store = options.store ?? new RewindStore({ root: options.storeRoot })
    this.config = options.config ?? {}
    this.sessions = options.sessions ?? (() => undefined)
    this.listSessions = options.listSessions ?? (() => [])
    this.log = options.logger ?? (() => {})
    /** Serializes snapshot walks per session so two boundaries cannot interleave. */
    this.queues = new Map()
    /** Live tool executions per session, used to mark a raced checkpoint. */
    this.inFlight = new Map()
    /** In-memory cache of manifests, keyed `<sessionId>/<checkpointId>`. */
    this.manifestCache = new Map()
    /** Registered workspaces, when the deployment mounts a workspace registry. */
    this.listWorkspaces = options.listWorkspaces ?? (() => [])
  }

  /** Prepare the store directory. */
  async init() {
    await this.store.init()
  }

  /** Note that a tool call is running for a session. */
  enterTool(sessionId) {
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1)
  }

  /** Note that a tool call finished for a session. */
  exitTool(sessionId) {
    const next = (this.inFlight.get(sessionId) ?? 1) - 1
    if (next <= 0) this.inFlight.delete(sessionId)
    else this.inFlight.set(sessionId, next)
  }

  /** Whether a session currently has tool work in flight. */
  isBusy(sessionId) {
    return (this.inFlight.get(sessionId) ?? 0) > 0
  }

  /** Enqueue work on one session's serial queue. */
  enqueue(sessionId, task) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(sessionId, next.catch(() => {}))
    return next
  }

  /** Workspace root for one session: its header cwd, or the stored index cwd. */
  async workspaceRoot(sessionId) {
    const session = this.sessions(sessionId)
    if (session?.header?.cwd !== undefined) return session.header.cwd
    const index = await this.store.loadIndex(sessionId)
    return index.cwd
  }

  /**
   * Create a checkpoint.
   *
   * @param options - `sessionId`, `afterTurn` (the boundary this checkpoint
   *   records: the state *after* that turn), `label`, `prompt`, `kind`, and
   *   `withManifest` (false produces a conversation-only checkpoint).
   */
  async createCheckpoint(options) {
    const { sessionId, afterTurn, kind } = options
    const session = this.sessions(sessionId)
    const createdAt = Date.now()
    const index = await this.store.loadIndex(sessionId)
    // One checkpoint per moment. A backfilled conversation-only entry is
    // upgraded in place when a real snapshot finally lands on the same turn,
    // and a repeated snapshot of the same moment replaces its predecessor
    // instead of stacking a second node on the same tree row.
    const existing = index.checkpoints.find((entry) => entry.afterTurn === afterTurn
      && (entry.kind === 'history' || entry.kind === kind))
    const id = existing?.id ?? `cp-${afterTurn}-${createdAt.toString(36)}`
    // An explicit root wins (tests, and callers that know better); otherwise
    // every workspace this conversation belongs to is covered.
    const roots = options.withManifest === true
      ? (options.root === undefined ? await this.resolveRoots(sessionId) : [normalizeRoot(options.root)])
      : []
    const root = roots[0] ?? options.root ?? session?.header?.cwd ?? (await this.workspaceRoot(sessionId))
    const checkpoint = {
      id,
      sessionId,
      afterTurn,
      kind: kind ?? 'auto',
      label: options.label ?? `第 ${afterTurn} 轮`,
      prompt: options.prompt === undefined ? '' : shorten(options.prompt, 160),
      createdAt,
      manifest: false,
      degraded: false,
      stats: undefined,
    }

    if (options.withManifest === true && roots.length > 0) {
      const startedAt = Date.now()
      const newest = index.checkpoints.find((entry) => entry.manifest === true && entry.id !== id)
      // Hash reuse is per root: a root whose files did not change costs one
      // stat per file, not a read.
      const previousByRoot = new Map()
      if (newest !== undefined) {
        for (const previous of await this.rootManifests(newest)) previousByRoot.set(previous.root, previous.manifest)
      }
      const degraded = this.isBusy(sessionId)
      const records = []
      const aggregate = { files: 0, bytes: 0, skipped: 0, truncated: false, roots: roots.length }
      let hashed = 0
      let reused = 0
      let walkMs = 0
      for (const [rootIndex, root] of roots.entries()) {
        const file = manifestFileFor(id, rootIndex)
        const walkStart = Date.now()
        const { manifest, counters } = await snapshotWorkspace(root, {
          store: this.store,
          previous: manifestIndex(previousByRoot.get(root)),
          excludeDirs: this.config.excludeDirs,
          excludeSuffixes: this.config.excludeSuffixes,
          excludeNames: this.config.excludeNames,
          maxBlobBytes: this.config.maxBlobBytes,
          maxTotalBytes: this.config.maxTotalBytes,
          maxFiles: this.config.maxFiles,
        })
        walkMs += Date.now() - walkStart
        manifest.checkpointId = id
        manifest.sessionId = sessionId
        manifest.afterTurn = afterTurn
        if (degraded) manifest.degraded = true
        await this.store.writeManifest(sessionId, file, manifest)
        this.manifestCache.set(`${sessionId}/${file}`, manifest)
        const stats = manifestStats(manifest)
        records.push({ root, file, stats })
        aggregate.files += stats.files
        aggregate.bytes += stats.bytes
        aggregate.skipped += stats.skipped
        aggregate.truncated = aggregate.truncated || stats.truncated
        hashed += counters.hashed
        reused += counters.reused
      }
      checkpoint.manifest = true
      checkpoint.roots = records
      checkpoint.degraded = degraded
      checkpoint.stats = aggregate
      checkpoint.walkMs = walkMs
      checkpoint.hashed = hashed
      checkpoint.reused = reused
    }

    await this.store.upsertCheckpoint(sessionId, checkpoint, root, session?.header?.parentSession)
    return checkpoint
  }

  /**
   * Every workspace root this conversation belongs to.
   *
   * A conversation can touch more than one directory: its own `cwd`, the cwd of
   * any fork ancestor or descendant in the same lineage, and every registered
   * workspace those sessions are attached to (a session opened inside a project
   * subdirectory still belongs to the project). All of them are snapshotted, so
   * a rollback returns the whole conversation's files, not one folder's.
   */
  async resolveRoots(sessionId) {
    const session = this.sessions(sessionId)
    const family = await this.familyIds(sessionId)
    const cwds = new Set()
    const addCwd = (value) => {
      if (typeof value === 'string' && value.trim() !== '') cwds.add(normalizeRoot(value))
    }
    addCwd(session?.header?.cwd)
    for (const other of this.listSessions()) {
      if (other.id === sessionId || family.has(other.id)) addCwd(other.header?.cwd)
    }
    const candidates = new Set(cwds)
    for (const workspace of this.listWorkspaces()) {
      const path = workspace?.path
      if (typeof path !== 'string' || path.trim() === '') continue
      const normalized = normalizeRoot(path)
      const attached = Array.isArray(workspace.sessionIds)
        && workspace.sessionIds.some((id) => id === sessionId || family.has(id))
      const overlaps = [...cwds].some((cwd) => isInside(normalized, cwd) || isInside(cwd, normalized))
      if (attached || overlaps) candidates.add(normalized)
    }
    const existing = []
    for (const root of candidates) {
      if (await isDirectory(root)) existing.push(root)
    }
    return existing.length > 0 ? existing : [...cwds].slice(0, 1)
  }

  /** Union of the roots every live root session would cover, de-duplicated. */
  async unionRoots() {
    const seen = new Set()
    for (const session of this.listSessions()) {
      if ((session.header?.delegationDepth ?? 0) > 0) continue
      for (const root of await this.resolveRoots(session.id)) seen.add(root)
    }
    return [...seen]
  }

  /** Session ids in one fork lineage: the session, its ancestors, its descendants. */
  async familyIds(sessionId) {
    const parents = new Map()
    for (const session of this.listSessions()) parents.set(session.id, session.header?.parentSession)
    for (const index of await this.store.listIndexes()) {
      if (!parents.has(index.sessionId)) parents.set(index.sessionId, index.parentSession)
    }
    const family = new Set([sessionId])
    let cursor = parents.get(sessionId)
    let guard = 0
    while (typeof cursor === 'string' && !family.has(cursor) && guard < 64) {
      family.add(cursor)
      cursor = parents.get(cursor)
      guard += 1
    }
    let changed = true
    while (changed) {
      changed = false
      for (const [id, parent] of parents) {
        if (family.has(id)) continue
        if (typeof parent === 'string' && family.has(parent)) {
          family.add(id)
          changed = true
        }
      }
    }
    return family
  }

  /**
   * The manifests one checkpoint owns, one per workspace root, newest format
   * first and the single-manifest legacy shape second.
   */
  async rootManifests(checkpoint) {
    if (checkpoint === undefined) return []
    const files = Array.isArray(checkpoint.roots) && checkpoint.roots.length > 0
      ? checkpoint.roots.map((entry) => ({ root: entry.root, file: entry.file }))
      : [{ root: undefined, file: checkpoint.id }]
    const manifests = []
    for (const entry of files) {
      if (typeof entry.file !== 'string') continue
      const manifest = await this.loadManifest(checkpoint.sessionId, entry.file)
      if (manifest === undefined) continue
      manifests.push({
        root: typeof entry.root === 'string' ? entry.root : manifest.root,
        file: entry.file,
        manifest,
      })
    }
    return manifests
  }

  /** Read a manifest through the in-memory cache. */
  async loadManifest(sessionId, checkpointId) {
    const key = `${sessionId}/${checkpointId}`
    if (this.manifestCache.has(key)) return this.manifestCache.get(key)
    const manifest = await this.store.readManifest(sessionId, checkpointId)
    if (manifest !== undefined) this.manifestCache.set(key, manifest)
    return manifest
  }

  /** Checkpoints belonging to one session, oldest boundary first. */
  async checkpointsFor(sessionId) {
    const index = await this.store.loadIndex(sessionId)
    return [...index.checkpoints].sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0))
  }

  /**
   * Analyze a session without letting one unusable object break the whole
   * panel. The recorded message is reported by `status`, so a shape this plugin
   * cannot read stays diagnosable instead of silently blanking the tree.
   */
  analyzeSafe(session) {
    try {
      return analyzeSession(session)
    } catch (error) {
      this.lastAnalysisError = String(error?.message ?? error)
      return undefined
    }
  }

  /** Find one checkpoint and its session id. */
  async findCheckpoint(checkpointId) {
    const indexes = await this.store.listIndexes()
    for (const index of indexes) {
      const found = (index.checkpoints ?? []).find((entry) => entry.id === checkpointId)
      if (found !== undefined) return { sessionId: index.sessionId, checkpoint: found, cwd: index.cwd }
    }
    return undefined
  }

  /**
   * Record conversation-only checkpoints for every past turn of a session that
   * has none yet, so the tree shows existing history the moment the plugin is
   * installed. These carry no workspace manifest by design: their file state was
   * never captured, and the UI must say so rather than pretend otherwise.
   */
  async backfill(sessionId) {
    const session = this.sessions(sessionId)
    if (session === undefined) return { created: 0, reason: 'not-live' }
    const analysis = analyzeSession(session)
    const existing = await this.checkpointsFor(sessionId)
    const known = new Set(existing.map((entry) => entry.afterTurn))
    // A forked child's log opens with the parent's prefix; those turns already
    // exist on the parent's lane and must not be re-drawn on the child's.
    // 0.2.x reports it as `inheritedEventCount`, 0.1.x as `header.seedLength`.
    const seedLength = inheritedEventCountOf(session)
    let created = 0
    for (const turn of analysis.turns) {
      if (turn.userSeq === undefined) continue
      if (turn.startSeq < seedLength) continue
      if (known.has(turn.turn)) continue
      await this.createCheckpoint({
        sessionId,
        afterTurn: turn.turn,
        kind: 'history',
        withManifest: false,
        label: `第 ${turn.turn} 轮`,
        prompt: turn.prompt,
        root: session.header.cwd,
      })
      created += 1
    }
    return { created }
  }

  /**
   * Build the tree payload for one session: its workspace family (sessions that
   * share a cwd, plus any fork lineage) and every checkpoint in those sessions.
   *
   * @param sessionId - the session to describe; omitted, the host picks the most
   *   recently active live root session so a client that cannot resolve its own
   *   shell state still gets a useful tree.
   */
  async overview(sessionId) {
    let resolvedId = sessionId
    let autoSelected = false
    if (typeof resolvedId !== 'string' || resolvedId === '') {
      resolvedId = await this.pickSession()
      autoSelected = true
      if (resolvedId === undefined) {
        return { currentSessionId: undefined, autoSelected, cwd: undefined, sessions: [], checkpoints: [], surfaces: {}, storeRoot: this.store.root }
      }
    }
    const current = this.sessions(resolvedId)
    const currentIndex = await this.store.loadIndex(resolvedId)
    const cwd = current?.header?.cwd ?? currentIndex.cwd

    const live = this.listSessions()
    const described = new Map()
    const describe = (session) => {
      const header = session.header ?? {}
      return {
        id: session.id,
        cwd: header.cwd,
        parentSession: header.parentSession,
        // Normalized fork prefix: 0.2.x keeps it on the instance, 0.1.x in the
        // durable header. The tree uses it to anchor a fork edge.
        inheritedEvents: inheritedEventCountOf(session),
        seedLength: header.seedLength,
        delegationDepth: header.delegationDepth ?? 0,
        createdAt: header.createdAt,
        agentPreset: header.agentPreset,
        live: true,
      }
    }
    for (const session of live) {
      if (typeof session?.id !== 'string' || session.id === '') continue
      const info = describe(session)
      if (info.delegationDepth > 0) continue
      if (cwd !== undefined && info.cwd !== cwd) continue
      described.set(info.id, info)
    }
    if (!described.has(sessionId)) {
      described.set(sessionId, {
        id: sessionId,
        cwd,
        parentSession: current?.header?.parentSession,
        inheritedEvents: current === undefined ? 0 : inheritedEventCountOf(current),
        seedLength: current?.header?.seedLength,
        delegationDepth: 0,
        createdAt: current?.header?.createdAt,
        live: current !== undefined,
      })
    }
    // Sessions recorded by the store but not live right now still appear.
    for (const index of await this.store.listIndexes()) {
      if (typeof index.sessionId !== 'string' || index.sessionId === '') continue
      if (described.has(index.sessionId)) continue
      if (cwd !== undefined && index.cwd !== cwd) continue
      described.set(index.sessionId, {
        id: index.sessionId,
        cwd: index.cwd,
        live: false,
      })
    }
    // Pull in ancestors named by parentSession so the fork lineage is complete.
    for (const info of [...described.values()]) {
      let parent = info.parentSession
      let guard = 0
      while (typeof parent === 'string' && !described.has(parent) && guard < 32) {
        const parentSession = this.sessions(parent)
        described.set(parent, parentSession === undefined
          ? { id: parent, cwd, live: false, ancestorOnly: true }
          : describe(parentSession))
        parent = parentSession?.header?.parentSession
        guard += 1
      }
    }

    const sessions = [...described.values()]
    const checkpoints = []
    const surfaceBySession = new Map()
    for (const info of sessions) {
      const session = this.sessions(info.id)
      const analysis = session === undefined ? undefined : this.analyzeSafe(session)
      if (analysis !== undefined) {
        surfaceBySession.set(info.id, {
          nodes: analysis.surfaceNodes.length,
          lastTurn: analysis.lastTurn,
          messageCount: analysis.messageCount,
          abandoned: analysis.abandonedSeqs.length,
          rewound: analysis.rewoundSeqs.length,
          compacted: analysis.compactedSeqs.length,
          replacements: analysis.replacements.length,
        })
      }
      const entries = await this.checkpointsFor(info.id)
      const seqByTurn = new Map()
      for (const turn of analysis?.turns ?? []) seqByTurn.set(turn.turn, turn)
      for (const entry of entries) {
        const boundaryTurn = seqByTurn.get(entry.afterTurn ?? 0)
        const nextTurn = seqByTurn.get((entry.afterTurn ?? 0) + 1)
        const dropped = analysis === undefined || nextTurn === undefined
          ? undefined
          : planRewind(session, nextTurn.userSeq)
        // Only a turn with a real human prompt can be a rewind or fork target;
        // an auto-continued round has nothing to cut back to.
        const nextHasPrompt = nextTurn?.hasPrompt === true
        checkpoints.push({
          ...entry,
          sessionId: info.id,
          live: info.live === true,
          // The user message a conversation rewind would cut at.
          targetUserSeq: nextHasPrompt ? nextTurn.userSeq : undefined,
          // The seq a shipped `sessions.fork` must be anchored at to cut exactly
          // after this checkpoint's turn: the RPC rounds up to the first
          // `turn/end` at or after `atSeq`, so the turn's own end seq is exact.
          forkAtSeq: boundaryTurn?.endSeq,
          canFork: boundaryTurn?.endSeq !== undefined && nextHasPrompt,
          hasNextTurn: nextHasPrompt,
          // Four different reasons a conversation action can be unavailable:
          // this plugin rewound it, the harness compacted it, the harness
          // replaced its prompt node, or another producer replaced it. They read
          // differently in the panel.
          alreadyRewound: nextHasPrompt && nextTurn.rewound === true,
          compacted: nextHasPrompt && nextTurn.compacted === true,
          promptReplaced: nextHasPrompt && nextTurn.promptReplaced === true,
          replacedByOther: nextHasPrompt && nextTurn.replacedByOther === true,
          reachable: nextHasPrompt && nextTurn.surfaced === true,
          abandoned: nextHasPrompt && nextTurn.surfaced !== true,
          droppedTurns: dropped?.ok === true ? dropped.droppedTurns.length : 0,
          canRestoreWorkspace: entry.manifest === true && this.sessions(info.id) !== undefined,
          rootsCount: Array.isArray(entry.roots) ? entry.roots.length : (entry.manifest === true ? 1 : 0),
        })
      }
      info.checkpointCount = entries.length
      info.turnCount = analysis?.turns.length ?? 0
      info.title = (analysis?.turns ?? []).find((turn) => turn.prompt !== '')?.prompt ?? ''
      info.abandoned = analysis?.abandonedSeqs.length ?? 0
      info.rewound = analysis?.rewoundSeqs.length ?? 0
      info.compacted = analysis?.compactedSeqs.length ?? 0
      info.promptReplaced = analysis?.promptReplacedSeqs.length ?? 0
    }

    return {
      currentSessionId: resolvedId,
      autoSelected,
      cwd,
      sessions,
      checkpoints: checkpoints.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
      surfaces: Object.fromEntries(surfaceBySession),
      storeRoot: this.store.root,
      retention: this.config.retainCheckpoints ?? this.store.retainCheckpoints,
      roots: await this.resolveRoots(resolvedId),
    }
  }

  /** Dry-run a rollback: what the conversation and the workspace would change. */
  async plan(checkpointId, actions = {}) {
    const found = await this.findCheckpoint(checkpointId)
    if (found === undefined) throw new RewindError('unknown-checkpoint', `no checkpoint ${checkpointId}`)
    const session = this.sessions(found.sessionId)
    const result = { checkpoint: found.checkpoint, sessionId: found.sessionId }

    if (actions.conversation !== undefined && actions.conversation !== 'none') {
      if (session === undefined) {
        result.conversation = { ok: false, reason: 'session-not-live', message: '该会话当前未在本进程打开，无法回退对话' }
      } else {
        const target = await this.targetSeqFor(found.sessionId, found.checkpoint)
        result.conversation = target === undefined
          ? { ok: false, reason: 'no-target-turn', message: '这个检查点之后还没有开始新的对话轮次' }
          : planRewind(session, target)
      }
    }

    if (actions.workspace === 'restore') {
      const manifests = found.checkpoint.manifest === true ? await this.rootManifests(found.checkpoint) : []
      if (manifests.length === 0) {
        result.workspace = { ok: false, reason: 'no-manifest', message: '该检查点只有对话记录，没有文件快照' }
      } else if (session === undefined) {
        result.workspace = { ok: false, reason: 'session-not-live', message: '该会话当前未在本进程打开' }
      } else {
        const roots = []
        const total = { dryRun: true, restored: 0, recreated: 0, deleted: 0, createdDirs: 0, removedDirs: 0, symlinks: 0, unchanged: 0, failed: [] }
        for (const entry of manifests) {
          const dry = await restoreWorkspace(entry.root, entry.manifest, {
            store: this.store,
            dryRun: true,
            excludeDirs: this.config.excludeDirs,
            excludeSuffixes: this.config.excludeSuffixes,
            excludeNames: this.config.excludeNames,
          })
          roots.push({ root: entry.root, summary: dry })
          addSummary(total, dry)
        }
        result.workspace = { ok: true, dryRun: true, summary: total, roots }
      }
    }
    return result
  }

  /** The user-message seq a checkpoint rewinds to (the next turn's prompt). */
  async targetSeqFor(sessionId, checkpoint) {
    const session = this.sessions(sessionId)
    if (session === undefined) return undefined
    const analysis = analyzeSession(session)
    const next = analysis.turns.find((turn) => turn.turn === (checkpoint.afterTurn ?? 0) + 1)
    return next?.userSeq
  }

  /**
   * Perform a rollback.
   *
   * @param checkpointId - the checkpoint to roll back to.
   * @param options - `conversation`: `'none' | 'inplace' | 'fork'`;
   *   `workspace`: `'none' | 'restore'`; `safety`: take a pre-rollback snapshot.
   */
  async apply(checkpointId, options = {}) {
    const found = await this.findCheckpoint(checkpointId)
    if (found === undefined) throw new RewindError('unknown-checkpoint', `no checkpoint ${checkpointId}`)
    const session = this.sessions(found.sessionId)
    if (session === undefined) {
      throw new RewindError('session-not-live', '该会话当前未在本进程打开，无法回退')
    }
    if (this.isBusy(found.sessionId)) {
      throw new RewindError('session-busy', '代理正在执行工具调用，请等这一轮结束后再回退')
    }

    const report = { checkpointId, sessionId: found.sessionId, conversation: undefined, workspace: undefined, safety: undefined }

    // Read the restore source BEFORE anything else touches the store, so a
    // freshly written safety backup can never be mistaken for the target.
    const targetManifests = options.workspace === 'restore' && found.checkpoint.manifest === true
      ? await this.rootManifests(found.checkpoint)
      : []

    if (options.workspace === 'restore' && this.config.safetyCheckpoint !== false) {
      // Exactly one backup per session: it is the undo target for the most
      // recent rollback, so a second rollback replaces it rather than stacking
      // another node on the same tree row.
      const currentTurn = await this.currentTurnOf(found.sessionId)
      report.safety = await this.enqueue(found.sessionId, async () => {
        const index = await this.store.loadIndex(found.sessionId)
        const previousSafety = index.checkpoints.filter((entry) => entry.kind === 'safety')
        if (previousSafety.length > 0) {
          await this.store.saveIndex({
            ...index,
            checkpoints: index.checkpoints.filter((entry) => entry.kind !== 'safety'),
          })
          for (const entry of previousSafety) {
            for (const file of manifestFilesOf(entry)) {
              await this.store.deleteManifest(found.sessionId, file)
              this.manifestCache.delete(`${found.sessionId}/${file}`)
            }
          }
        }
        return this.createCheckpoint({
          sessionId: found.sessionId,
          afterTurn: currentTurn + 0.5,
          kind: 'safety',
          withManifest: true,
          label: '回滚前自动备份',
          prompt: `回滚到 ${found.checkpoint.id} 之前的现场`,
        })
      })
    }

    if (options.conversation === 'inplace') {
      const target = await this.targetSeqFor(found.sessionId, found.checkpoint)
      if (target === undefined) throw new RewindError('no-target-turn', '这个检查点之后还没有开始新的对话轮次')
      const plan = planRewind(session, target)
      if (plan.ok !== true) throw new RewindError(plan.reason, plan.message ?? '无法回退对话')
      const event = applyRewind(session, plan)
      report.conversation = {
        mode: 'inplace',
        seq: event.seq,
        shadowed: plan.shadowed.length,
        droppedTurns: plan.droppedTurns,
        targetTurn: plan.targetTurn,
      }
    }

    if (options.workspace === 'restore') {
      if (targetManifests.length === 0) throw new RewindError('no-manifest', '该检查点没有文件快照')
      const total = { dryRun: false, restored: 0, recreated: 0, deleted: 0, createdDirs: 0, removedDirs: 0, symlinks: 0, unchanged: 0, failed: [], roots: [] }
      for (const entry of targetManifests) {
        const summary = await restoreWorkspace(entry.root, entry.manifest, {
          store: this.store,
          excludeDirs: this.config.excludeDirs,
          excludeSuffixes: this.config.excludeSuffixes,
          excludeNames: this.config.excludeNames,
          trashDir: this.config.trashOnRollback === true ? this.store.trashDir(found.checkpoint.id) : undefined,
        })
        total.roots.push({ root: entry.root, summary })
        addSummary(total, summary)
      }
      delete total.rootsManifests
      report.workspace = total
    }
    return report
  }

  /** Highest turn number currently in a session's log. */
  async currentTurnOf(sessionId) {
    const session = this.sessions(sessionId)
    if (session === undefined) return 0
    return analyzeSession(session).lastTurn
  }

  /** Delete one checkpoint (its manifest and index entry; blobs stay for GC). */
  async remove(checkpointId) {
    const found = await this.findCheckpoint(checkpointId)
    if (found === undefined) return { removed: false }
    await this.store.withLock(`index:${found.sessionId}`, async () => {
      const index = await this.store.loadIndex(found.sessionId)
      await this.store.saveIndex({
        ...index,
        checkpoints: index.checkpoints.filter((entry) => entry.id !== checkpointId),
      })
    })
    for (const file of manifestFilesOf(found.checkpoint)) {
      await this.store.deleteManifest(found.sessionId, file)
      this.manifestCache.delete(`${found.sessionId}/${file}`)
    }
    return { removed: true }
  }

  /**
   * The session a client means when it names none: the live root session that
   * most recently produced an event. The panel uses this so a shell that cannot
   * resolve its active session still shows the conversation being worked in.
   */
  async pickSession() {
    const live = this.listSessions()
      .filter((session) => (session.header?.delegationDepth ?? 0) === 0)
      .filter((session) => {
        try {
          return readSessionEvents(session).length > 0
        } catch {
          return false
        }
      })
    if (live.length === 0) return undefined
    let best
    let bestTime = -1
    for (const session of live) {
      const events = readSessionEvents(session)
      const last = events[events.length - 1]
      const time = typeof last?.time === 'number' ? last.time : 0
      const indexes = await this.store.loadIndex(session.id)
      const score = time + (indexes.checkpoints.length > 0 ? 1 : 0)
      if (score > bestTime) {
        bestTime = score
        best = session.id
      }
    }
    return best
  }

  /** Plugin status for the panel header. */
  async status() {
    const indexes = await this.store.listIndexes()
    const usage = await this.store.blobUsage()
    const live = this.listSessions()
    const readable = live.filter((session) => {
      try {
        readSessionEvents(session)
        return true
      } catch {
        return false
      }
    })
    const flavor = live.some((session) => typeof session?.snapshotEvents === 'function')
      ? '0.2.x'
      : live.some((session) => Array.isArray(session?.events)) ? '0.1.x' : 'unknown'
    return {
      storeRoot: this.store.root,
      sessions: indexes.length,
      checkpoints: indexes.reduce((sum, index) => sum + (index.checkpoints?.length ?? 0), 0),
      blobs: usage,
      liveSessions: live.filter((session) => (session.header?.delegationDepth ?? 0) === 0).length,
      // Every workspace root any live conversation would cover, so the panel can
      // promise the same scope the next snapshot will actually take.
      roots: await this.unionRoots(),
      diagnostics: {
        sessionApiFlavor: flavor,
        liveSessions: live.length,
        readableSessions: readable.length,
        lastAnalysisError: this.lastAnalysisError ?? null,
      },
    }
  }

  /** Remove blobs no checkpoint references. */
  async collectGarbage() {
    return this.store.collectGarbage()
  }

  /** Create a trash directory for a rollback so deletions can be undone. */
  async prepareTrash(checkpointId) {
    const dir = this.store.trashDir(checkpointId)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /** Absolute path helper used by tests and the UI's "reveal" affordances. */
  blobPath(sha256) {
    return this.store.blobPath(sha256)
  }

  /** Directory of one session's manifests, for diagnostics. */
  manifestDir(sessionId) {
    return join(this.store.root, 'manifests', String(sessionId))
  }
}
