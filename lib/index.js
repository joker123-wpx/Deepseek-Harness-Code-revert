/**
 * dsh-plugin-rewind — host half.
 *
 * Mounts a durable checkpoint store, a rollback engine, the same-origin RPC
 * route the browser half calls, two session/tool hooks that create checkpoints
 * at turn boundaries, and an optional model-facing tool.
 *
 * See README.md for the design, the two conversation-rewind modes, and the
 * deliberate trade-offs.
 *
 * @module dsh-plugin-rewind
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { messageText, shorten } from './conversation.js'
import { RewindEngine } from './engine.js'
import { createRpcHandler } from './rpc.js'
import { RewindStore } from './store.js'

/** Cordis plugin name, used by Loader diagnostics. */
export const name = 'rewind'

/** Hard dependencies: the route registry and the session store. */
export const inject = ['webServer', 'sessions']

/** Route the browser half posts to. */
export const ROUTE_PATH = '/dsh-rewind/rpc'

/** Resolve the Harness home the way `dsh-home-paths` does, without importing it. */
function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** The plugin's author and home; also shipped to agents as provenance. */
export const AUTHOR = {
  name: 'joker123-wpx',
  profile: 'https://github.com/joker123-wpx',
  repository: 'https://github.com/joker123-wpx/Deepseek-Harness-Code-revert',
}

/**
 * Build identity, shared with the browser half.
 *
 * The two halves load independently — the client is served from disk on every
 * request (so a page refresh updates it) while the host half needs a process
 * restart. Comparing the two build ids in the panel turns "it still does not
 * work" into "the host half is older, restart".
 */
export const BUILD_ID = '2026-10-05.1'

/** Guidance handed to every agent through the system-prompt band. */
const AGENT_GUIDANCE = [
  '本机已安装 dsh-plugin-rewind 插件（对话回退 / 工作区回滚）。',
  '它在每一轮对话边界为工作区建立内容寻址快照，并支持把模型可见的对话历史回退到任意一轮之前。',
  '用户提到「回退 / 回滚 / 撤销到某一轮 / 恢复代码」时，使用 rewind 工具，或直接告诉用户在侧栏的「回退」面板里选择检查点；面板提供两种对话回退：',
  '「新分支回退」派生一个只含该轮之前历史的新会话（可见地真正回退，原会话保留为旁支）；「就地遗忘」在当前会话内追加一次 surface 替换，模型不再看到被回退的内容，而聊天记录仍保留（作为已废弃分支显示在树图上）。',
  '工作区回滚会先自动建立「回滚前自动备份」检查点，可以再次回滚回去。',
  '面板里的「该轮提问」可以直接编辑，金色按钮「回退并重新提问」会撤销这一轮并把你改写的提问重新发出去。',
  `插件作者：${AUTHOR.name}（${AUTHOR.profile}），仓库：${AUTHOR.repository}`,
].join('\n')

/**
 * Mount the plugin.
 *
 * @param ctx - context carrying `webServer` and `sessions`.
 * @param config - the loader row's config (see README for the keys).
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const logger = typeof ctx.logger === 'function' ? ctx.logger('rewind') : undefined
  const log = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }

  const storeRoot = config.storeRoot ?? join(resolveDshHome(config.dshHome), 'rewind', 'v1')
  const store = new RewindStore({ root: storeRoot, retainCheckpoints: config.retainCheckpoints ?? 200 })
  const engine = new RewindEngine({
    store,
    config,
    sessions: (id) => ctx.sessions.get(id),
    listSessions: () => ctx.sessions.list(),
    // The workspace registry is optional: without it a checkpoint still covers
    // every cwd in the conversation's own fork lineage.
    buildId: BUILD_ID,
    listWorkspaces: () => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return []
      try {
        return registry.list()
      } catch {
        return []
      }
    },
    logger: log,
  })

  engine.init().catch((error) => log(`dsh-plugin-rewind: cannot initialize ${storeRoot}: ${String(error)}`))

  // ── transport ────────────────────────────────────────────────────────────
  const handler = createRpcHandler(engine, { routePath: ROUTE_PATH, logger: log })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'dsh-plugin-rewind: rpc route',
  )

  // ── turn-boundary checkpoints ────────────────────────────────────────────
  /** Per-session bookkeeping for turn labels. */
  const state = new Map()
  const stateFor = (sessionId) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      entry = { initial: false, currentTurn: undefined, promptByTurn: new Map() }
      state.set(sessionId, entry)
    }
    return entry
  }

  ctx.on('session/event', (session, event) => {
    if ((session.header?.delegationDepth ?? 0) > 0) return
    if (session.header?.cwd === undefined) return
    // A rollback the panel asked for while nothing was open lands here, at the
    // first step of the next turn: only then is a surface replacement loadable
    // again, and appending it before this step's request is assembled means the
    // new prompt is answered against the rewound history. Nothing the user sees.
    // Deferred to a microtask, because this hook runs INSIDE the session's own
    // append and a session refuses a reentrant append.
    if (event.type === 'step/start' || event.type === 'turn/start') {
      queueMicrotask(() => {
        try {
          engine.applyScheduled(session)
        } catch (error) {
          log(`dsh-plugin-rewind: scheduled rewind threw: ${String(error)}`)
        }
      })
    }
    if (config.autoSnapshot === false) return
    const entry = stateFor(session.id)
    switch (event.type) {
      case 'turn/start': {
        entry.currentTurn = event.data.turn
        if (!entry.initial) {
          entry.initial = true
          // A forked child opens on the parent's prefix: its row-0 moment is
          // the parent's, so only a root branch records an initial snapshot.
          if (session.header?.parentSession === undefined) {
            const afterTurn = 0
            void engine.enqueue(session.id, () => engine.createCheckpoint({
              sessionId: session.id,
              afterTurn,
              kind: 'auto',
              withManifest: true,
              label: '初始状态',
              prompt: '会话开始时的现场',
            })).catch((error) => log(`dsh-plugin-rewind: initial checkpoint failed: ${String(error)}`))
          }
        }
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== 'user') return
        if (entry.currentTurn === undefined) return
        entry.promptByTurn.set(entry.currentTurn, messageText(event.data))
        break
      }
      case 'turn/end': {
        const turn = event.data.turn
        const prompt = entry.promptByTurn.get(turn) ?? ''
        void engine.enqueue(session.id, () => engine.createCheckpoint({
          sessionId: session.id,
          afterTurn: turn,
          kind: 'auto',
          withManifest: true,
          label: prompt === '' ? `第 ${turn} 轮` : `第 ${turn} 轮 · ${shorten(prompt, 36)}`,
          prompt,
        }))
          .then(() => engine.drainPending(session.id))
          .catch((error) => log(`dsh-plugin-rewind: checkpoint after turn ${turn} failed: ${String(error)}`))
        break
      }
      default:
        break
    }
  })

  // In-flight tool accounting: a snapshot taken while a tool body is running
  // cannot represent a clean turn boundary, so the checkpoint is marked
  // degraded instead of pretending to be exact.
  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id
    if (sessionId === undefined || exec.parent !== undefined) return next()
    engine.enterTool(sessionId)
    try {
      return await next()
    } finally {
      engine.exitTool(sessionId)
    }
  })

  // ── optional model-facing tool ───────────────────────────────────────────
  if (config.registerTool !== false) {
    void registerTool(ctx, engine, log)
  }

  // ── optional agent announcement ──────────────────────────────────────────
  if (config.announceToAgent !== false) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(
        () => systemPrompt.section({ name: 'plugin:dsh-plugin-rewind', order: 300, text: AGENT_GUIDANCE }),
        'dsh-plugin-rewind: prompt section',
      )
    }
  }
}

/**
 * Register the model-callable `rewind` tool. The definition helper lives in a
 * first-party package, so it is imported lazily and a resolution failure only
 * costs the tool, never the panel.
 */
async function registerTool(ctx, engine, log) {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    log(`dsh-plugin-rewind: model tool unavailable (${String(error)})`)
    return
  }
  const render = (value) => [{ type: 'text', text: renderReport(value) }]
  try {
    ctx.effect(() => tools.register(defineTool({
      name: 'rewind',
      description: [
        'Inspect and roll back this workspace and conversation using dsh-plugin-rewind checkpoints.',
        'action=status lists the checkpoints of the current session (id, turn, label, whether it has a file snapshot).',
        'action=apply rolls back: workspace=restore reverts every file the agent changed after that checkpoint',
        '(a safety checkpoint is taken automatically first), conversation=inplace makes the model forget every turn',
        'from the checkpoint onward, and conversation=fork is unavailable here because only the browser panel can',
        'switch the user to a new branch. Never call action=apply without the user explicitly asking for a rollback.',
        `Plugin by ${AUTHOR.name} — ${AUTHOR.repository}.`,
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, enum: ['status', 'apply'], description: 'status to inspect, apply to roll back' },
        checkpoint_id: { type: 'string', description: 'checkpoint id from action=status; required for action=apply' },
        workspace: { type: 'boolean', description: 'restore workspace files to the checkpoint (default true for apply)' },
        conversation: { type: 'boolean', description: 'roll the model-visible conversation back (default true for apply)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session?.id
        if (sessionId === undefined) throw new Error('rewind needs a session')
        await engine.backfill(sessionId)
        if (args.action === 'status') {
          const overview = await engine.overview(sessionId)
          return {
            cwd: overview.cwd,
            checkpoints: overview.checkpoints.map((checkpoint) => ({
              id: checkpoint.id,
              afterTurn: checkpoint.afterTurn,
              label: checkpoint.label,
              hasFileSnapshot: checkpoint.manifest === true,
              reachable: checkpoint.reachable === true,
              abandoned: checkpoint.abandoned === true,
            })),
          }
        }
        if (typeof args.checkpoint_id !== 'string' || args.checkpoint_id === '') {
          throw new Error('checkpoint_id is required for action=apply')
        }
        return engine.apply(args.checkpoint_id, {
          conversation: args.conversation === false ? 'none' : 'inplace',
          workspace: args.workspace === false ? 'none' : 'restore',
        })
      },
    })), 'dsh-plugin-rewind: model tool')
  } catch (error) {
    log(`dsh-plugin-rewind: model tool registration failed (${String(error)})`)
  }
}

/** Render a rollback report as compact text for the model. */
function renderReport(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (Array.isArray(value.checkpoints)) {
    const lines = value.checkpoints.map((checkpoint) => `- ${checkpoint.id} · 第 ${checkpoint.afterTurn} 轮 · ${checkpoint.label}`
      + `${checkpoint.hasFileSnapshot ? ' · 含文件快照' : ' · 仅对话'}`
      + `${checkpoint.reachable ? '' : ' · 已回退过'}`
      + `${checkpoint.abandoned ? ' · 已废弃分支' : ''}`)
    return [`工作区 ${value.cwd ?? '(未知)'}`, ...lines].join('\n')
  }
  const parts = []
  if (value.conversation !== undefined) {
    parts.push(value.conversation.mode === 'inplace'
      ? `对话已就地回退：遮蔽 ${value.conversation.shadowed} 个历史节点（日志保留）`
      : `对话分支：${JSON.stringify(value.conversation)}`)
  }
  if (value.workspace !== undefined) {
    const summary = value.workspace
    parts.push(`工作区回滚：重写 ${summary.restored} 个文件、恢复 ${summary.recreated} 个、删除 ${summary.deleted} 个`
      + `${summary.failed?.length > 0 ? `，失败 ${summary.failed.length} 个` : ''}`)
  }
  if (value.safety !== undefined) parts.push(`已建立回滚前备份检查点 ${value.safety.id}`)
  return parts.length > 0 ? parts.join('\n') : JSON.stringify(value)
}
