/**
 * dsh-plugin-rewind — browser half.
 *
 * A hand-written client bundle: the module system hands the factory a
 * `require` that resolves the platform seed table (`react`, `react-dom`, …)
 * plus every already-registered plugin bundle. Everything here is plain
 * JavaScript with `React.createElement`; there is no JSX, no TypeScript and no
 * build step, which is why the surfaces register into declared slots instead of
 * mounting DOM of their own.
 *
 * Surfaces registered:
 *   - `sidebar.footer.action` — the panel trigger.
 *   - `shell.overlay`         — the frame-wide drawer (the declared overlay seat).
 *   - `settings.section`      — a settings page that always reaches the same panel.
 *
 * The graph is drawn as an SVG tree: rows are conversation turns, columns are
 * branches. No emoji is used anywhere — every glyph is an SVG path.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-rewind',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ───────────────────────────────────────────────────────────────────────
    // styles
    // ───────────────────────────────────────────────────────────────────────
    const CSS = `
.rw-root{--rw-bg:var(--dsw-alias-bg-layer-1,#1b1b1d);--rw-bg-2:var(--dsw-alias-bg-layer-2,#232326);--rw-bg-3:var(--dsw-alias-bg-layer-3,#2a2a2e);--rw-line:var(--dsw-alias-border-l2,rgba(255,255,255,.13));--rw-line-strong:var(--dsw-alias-border-l3,rgba(255,255,255,.26));--rw-fg:var(--dsw-alias-label-primary,#f2f2f3);--rw-fg-2:var(--dsw-alias-label-secondary,#b9b9bd);--rw-fg-3:var(--dsw-alias-label-tertiary,#84848c);--rw-accent:var(--dsw-alias-state-business-primary,#6ea8fe);--rw-ok:var(--dsw-alias-state-success-primary,#5fbf7f);--rw-warn:var(--dsw-alias-state-warn-primary,#d9a13a);--rw-danger:var(--dsw-alias-state-error-primary,#e06b6b);--rw-titlebar-height:44px;color:var(--rw-fg);font-size:13px;line-height:20px;-webkit-app-region:no-drag}
/* The layer centres the panel, so the gap left and right of it is the same one:
   anchored to the right edge, the left gap was whatever space was left over while
   the right gap was only the padding, which read as lopsided. */
.rw-overlay-layer{position:absolute;inset:0;z-index:22;pointer-events:none;display:flex;justify-content:center;padding:var(--rw-titlebar-height) 14px 14px 14px}
/* Open and close are animated: the layer is never unmounted, so the drawer can
   slide back out. visibility keeps the closed state out of the tab order. */
.rw-overlay-layer[data-state=closed]{visibility:hidden;transition:visibility 0s linear .24s}
.rw-overlay-layer[data-state=open]{visibility:visible}
.rw-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.44);pointer-events:auto;border:0;padding:0;cursor:default;opacity:1;transition:opacity .22s ease}
.rw-overlay-layer[data-state=closed] .rw-backdrop{opacity:0;pointer-events:none}
/* Equal margins on every side: the layer pads 14px left, right and bottom and
   clears the product's title bar at the top, so the panel stops short of the
   window edge instead of hugging it (its 860px cap keeps long lines readable). */
.rw-drawer{position:relative;pointer-events:auto;height:100%;width:min(860px,100%);background:var(--rw-bg);border:1px solid var(--rw-line);border-radius:12px;display:flex;flex-direction:column;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.45));outline:none;overflow:hidden;transform:translateX(0);opacity:1;transition:transform .24s cubic-bezier(.22,.61,.36,1),opacity .24s ease}
.rw-overlay-layer[data-state=closed] .rw-drawer{transform:translateY(10px) scale(.99);opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){.rw-drawer,.rw-backdrop{transition:none}}
.rw-page{background:var(--rw-bg-2);border:1px solid var(--rw-line);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;min-height:520px}
.rw-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--rw-line);flex:none}
.rw-title{font-size:14px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:8px;white-space:nowrap}
.rw-sub{color:var(--rw-fg-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}
.rw-badge{border:1px solid var(--rw-line);border-radius:10px;padding:1px 8px;color:var(--rw-warn);font-size:11px;white-space:nowrap}
.rw-spacer{flex:1 1 auto}
.rw-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--rw-line);background:transparent;color:var(--rw-fg);font-size:12px;cursor:pointer;font-family:inherit}
.rw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.rw-btn:disabled{opacity:.5;cursor:not-allowed}
.rw-btn[data-variant=primary]{background:var(--rw-accent);border-color:transparent;color:#10131a;font-weight:600}
/* A disabled primary action must not still read as the recommended one. */
.rw-btn[data-variant=primary]:disabled{background:transparent;border-color:var(--rw-line);color:var(--rw-fg-3);font-weight:400;opacity:.7}
.rw-btn[data-variant=danger]{border-color:var(--rw-danger);color:var(--rw-danger)}
.rw-btn[data-variant=quiet]{border-color:transparent;color:var(--rw-fg-2)}
/* Gold marks the one action that changes the conversation's future: rewind and
   ask again. It is the only gold control in the panel, so it never has to be
   found by reading. */
.rw-btn[data-variant=gold]{background:var(--rw-warn);border-color:transparent;color:#2a1f05;font-weight:600}
.rw-btn[data-variant=gold]:hover:not(:disabled){background:color-mix(in srgb,var(--rw-warn) 88%,#fff)}
.rw-btn[data-variant=gold]:disabled{background:transparent;border-color:var(--rw-warn);color:var(--rw-warn);font-weight:400;opacity:.5}
.rw-body{position:relative;display:flex;flex:1 1 auto;min-height:0}
/* The details pane floats over the timeline, so selecting a row never reflows or
   re-measures the graph and the panel never shows a reserved empty column. */
.rw-side{position:absolute;top:10px;right:10px;bottom:10px;width:min(380px,46%);z-index:2;overflow:auto;background:var(--rw-bg);border:1px solid var(--rw-line-strong);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.45));padding:12px 14px 16px 14px}
.rw-graph{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;background:var(--rw-bg-2)}
.rw-scroll{flex:1 1 auto;min-height:0;overflow-y:scroll;overflow-x:hidden;scrollbar-gutter:stable}
.rw-scroll::-webkit-scrollbar{width:10px}
.rw-scroll::-webkit-scrollbar-thumb{background:var(--rw-line-strong);border-radius:5px}
.rw-scroll::-webkit-scrollbar-track{background:transparent}
.rw-scroll svg{display:block}
.rw-fold{display:flex;align-items:center;gap:8px;width:calc(100% - 24px);margin:6px 12px 8px 12px;padding:6px 10px;border:1px dashed var(--rw-line-strong);border-radius:8px;background:transparent;color:var(--rw-fg-3);font-size:11.5px;font-family:inherit;cursor:pointer}
.rw-fold:hover{color:var(--rw-fg);border-color:var(--rw-accent)}
.rw-side{flex:0 0 336px;border-left:1px solid var(--rw-line);padding:12px 14px 16px 14px;overflow:auto;background:var(--rw-bg)}
.rw-side-head{display:flex;align-items:center;gap:8px;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid var(--rw-line)}
.rw-foot{flex:none;border-top:1px solid var(--rw-line);padding:8px 14px;color:var(--rw-fg-3);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.rw-foot .rw-btn{height:26px}
.rw-build{color:var(--rw-fg-3);opacity:.7;font-size:11px}
.rw-last{color:var(--rw-fg-3);font-size:11px;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-last[data-outcome=error]{color:var(--rw-danger)}
.rw-last[data-outcome=queued]{color:var(--rw-warn)}
.rw-badge[data-kind=warn]{border-color:var(--rw-warn);color:var(--rw-warn)}
.rw-author{gap:6px;color:var(--rw-fg-3);text-decoration:none;padding:0 8px}
.rw-author:hover{color:var(--rw-fg);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.rw-author svg{opacity:.85}
.rw-author:hover svg{opacity:1}
.rw-empty{padding:32px 20px;color:var(--rw-fg-3);font-size:13px;max-width:52ch}
.rw-node{cursor:pointer;outline:none}
.rw-card{transition:fill .12s ease,stroke .12s ease}
.rw-node:hover .rw-card{stroke:var(--rw-line-strong);fill:rgba(255,255,255,.06)}
.rw-fork{transition:stroke .12s ease}
.rw-fork-surface{stroke-dasharray:none}
.rw-rail-dead{stroke-linecap:butt}
.rw-node:focus-visible .rw-card{stroke:var(--rw-line-strong)}
.rw-legend{display:flex;gap:14px;flex-wrap:wrap;padding:10px 16px;color:var(--rw-fg-3);font-size:11.5px;align-items:center;flex:none;border-bottom:1px solid var(--rw-line)}
.rw-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.rw-legend-hint{margin-left:auto;padding-left:14px;color:var(--rw-fg-3);opacity:.85}
.rw-legend-queued{margin-left:auto;display:inline-flex;align-items:center;gap:8px;color:var(--rw-warn)}
.rw-legend-queued .rw-btn{height:22px;padding:0 8px;font-size:11.5px;color:var(--rw-fg-3)}
.rw-row{display:grid;grid-template-columns:82px 1fr;gap:8px;align-items:baseline;margin:0 0 9px 0}
.rw-k{color:var(--rw-fg-3);font-size:12px}
.rw-v{min-width:0;word-break:break-word;font-size:12.5px}
.rw-prompt{display:block;width:100%;box-sizing:border-box;background:var(--rw-bg-3);border:1px solid var(--rw-line);border-radius:10px;padding:9px 11px;color:var(--rw-fg-2);white-space:pre-wrap;word-break:break-word;max-height:180px;min-height:64px;overflow:auto;font-size:12px;font-family:inherit;line-height:18px;resize:vertical}
.rw-prompt:focus{outline:none;border-color:var(--rw-accent);color:var(--rw-fg)}
.rw-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--rw-line)}
.rw-actions{display:flex;flex-direction:column;gap:8px}
.rw-actions .rw-btn{justify-content:flex-start;height:32px;border-radius:9px;padding:0 12px}

.rw-hint{color:var(--rw-fg-3);font-size:11.5px;margin-top:-2px}
.rw-reask{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.rw-reask-btn{flex:0 0 auto;align-self:flex-start;height:30px;padding:0 12px;border-radius:8px;font-size:12.5px}
.rw-edit-dot{width:7px;height:7px;border-radius:50%;background:rgba(42,31,5,.75);display:inline-block}
.rw-reask .rw-hint{margin:0}
.rw-modal-wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:3;pointer-events:auto}
/* The backdrop is an absolutely positioned sibling, so it paints above a static
   dialog and swallows every click — which looked exactly like "the dialog opens,
   nothing is clickable, and clicking it closes it". Both boxes get an explicit
   stacking order now, and the dialog also stops clicks from reaching the
   backdrop, so the layer order cannot make the buttons dead again. */
.rw-backdrop{z-index:0}
.rw-modal{position:relative;z-index:1;width:min(520px,92%);background:var(--rw-bg);border:1px solid var(--rw-line-strong);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.5));padding:16px}
.rw-modal h4{margin:0 0 10px 0;font-size:14px}
.rw-modal ul{margin:8px 0 0 0;padding-left:18px;color:var(--rw-fg-2)}
.rw-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.rw-banner{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--rw-line);border-radius:10px;padding:8px 11px;margin:10px 14px 0 14px;font-size:12px;color:var(--rw-fg-2)}
.rw-banner[data-kind=error]{border-color:var(--rw-danger);color:var(--rw-danger)}
.rw-banner[data-kind=ok]{border-color:var(--rw-ok);color:var(--rw-ok)}
.rw-banner-text{flex:1 1 auto;min-width:0}
.rw-banner-x{flex:0 0 auto;background:none;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
.rw-banner-x:hover{opacity:1}
.rw-list{margin:0;padding:0;list-style:none;font-size:12px;color:var(--rw-fg-2)}
.rw-list li{padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rw-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}
.rw-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--rw-line-strong);border-top-color:var(--rw-accent);border-radius:50%;animation:rw-spin .8s linear infinite;vertical-align:-2px}
@keyframes rw-spin{to{transform:rotate(360deg)}}
`
    const CSS_TAG_ID = 'dsh-plugin-rewind/panel.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-rewind'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ───────────────────────────────────────────────────────────────────────
    // copy
    // ───────────────────────────────────────────────────────────────────────
    const NS = 'rewind'
    const zh = {
      'action.refresh': '刷新',
      'action.snapshot': '立即创建检查点',
      'action.gc': '清理未引用数据',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.confirm': '确认执行',
      'action.running': '执行中…',
      'action.retry': '重试',
      'action.gotIt': '知道了',
      'action.dismiss': '关闭提示',
      'notice.reaskCodeViaAgent': '回退代码并重新提问（下一轮生效）',
      'notice.inplaceCodeViaAgent': '回退代码并遗忘对话（下一轮生效）',
      'action.reaskCode': '回退代码并重新提问',
      'action.rewindHere': '回退到此',
      'action.inplaceCode': '回退代码并遗忘对话',
      'notice.scheduled': '回退已排定：它会在下一轮开始时自动执行（会话日志只能在打开的轮次里写入）。',
      'notice.scheduledReask': '文件已回退；对话回退会在这一轮开始时自动执行，你的提问已发送。',
      'notice.agentExplain': '面板在对话空闲时无法安全写入会话日志（回退标记必须落在一段打开的 turn/step 里），所以回退会在**下一轮开始时自动执行**——面板只发送你自己的提问，不会把内部指令发进对话。',
      'notice.bothViaAgent': '回退代码与对话并重新提问（下一轮生效）',
      'notice.reaskViaAgent': '回退并重新提问（下一轮生效）',
      'notice.inplaceViaAgent': '就地回退（下一轮生效）',
      'notice.nothingToDo': '这次操作没有可执行的内容（内部状态不一致），已中止以免静默失败。',
      'action.fork': '回退对话（新分支）',
      'action.inplace': '回退对话（就地遗忘）',
      'action.workspace': '回滚工作区文件',
      'action.both': '全部回退（新分支 + 文件）',
      'action.bothInplace': '全部回退（就地遗忘 + 文件）',
      'action.restoreSafety': '恢复到这次备份',
      'action.openBranch': '打开该分支',
      'settings.title': '对话回退',
      'panel.title': '对话回退 / 工作区回滚',
      'panel.legend.current': '当前分支',
      'panel.legend.abandoned': '已废弃分支',
      'panel.legend.snapshot': '含文件快照',
      'panel.legend.conversationOnly': '仅对话记录',
      'panel.legend.safety': '回滚前备份',
      'panel.turn': '轮次',
      'panel.turnZero': '起始',
      'panel.inherited': '（继承自父分支）',
      'detail.title': '检查点详情',
      'detail.close': '收起详情',
      'action.reask': '回退并重新提问',
      'detail.promptEdited': '提问已改写',
      'notice.reaskShort': '撤销这一轮，并按上面的提问重新发送。',
      'detail.promptHint': '可以直接改这段提问；回车换行，不会触发其它操作。',
      'notice.reaskExplain': '会先撤销这一轮（模型不再看到它），再把你改好的这段提问送进输入框并发送成新的一轮；日志与树图保留原记录。',
      'notice.reaskConfirm': '将撤销这一轮，并用上面这段提问重新发起一轮（金色按钮）；原记录仍完整保留在日志与树图中。',
      'notice.reaskEmpty': '提问不能为空。',
      'notice.reaskNoComposer': '拿不到输入框控制权（会话座位未挂载），已回退但没有发送；请手动粘贴提问。',
      'notice.queued': '代理正在工作，本轮回退已排队：它一空闲就会自动执行（面板会留记录）。',
      'notice.queuedDone': '排队的回退已完成',
      'notice.queuedFailed': '排队的回退失败了',
      'notice.queuedPending': '已排队：本轮结束后自动回退',
      'action.cancelQueued': '取消排队',
      'detail.none': '在左侧树图上选择任意节点。',
      'detail.turn': '轮次',
      'detail.time': '时间',
      'detail.kind': '类型',
      'detail.files': '文件',
      'usage.tokens': 'token',
      'usage.tools': '工具',
      'usage.title': '这一轮用量',
      'usage.input': '输入',
      'usage.output': '输出',
      'usage.cacheRead': '缓存读',
      'usage.total': '合计',
      'usage.steps': '步数',
      'usage.duration': '耗时',
      'usage.toolCalls': '工具调用',
      'usage.model': '模型',
      'detail.prompt': '该轮提问',
      'detail.dropped': '将回退掉',
      'detail.droppedTurns': '轮对话',
      'detail.stats': '快照规模',
      'detail.branch': '所属分支',
      'detail.forkAt': '分支锚点',
      'kind.auto': '自动',
      'kind.manual': '手动',
      'kind.history': '历史（无文件快照）',
      'kind.safety': '回滚前备份',
      'badge.current': '当前分支',
      'badge.newBranch': '回退后新分支',
      'badge.deadBranch': '已回退的死支',
      'badge.rewound': '已回退',
      'badge.compacted': '已压缩',
      'badge.replaced': '已被替换',
      'badge.promptReplaced': '提示已更新',
      'badge.conversationOnly': '仅对话',
      'badge.safety': '备份',
      'panel.autoSelected': '已自动选择最近活跃的会话',
      'panel.selectHint': '点选任意检查点查看详情',
      'panel.groupRow': '第 {from} – {to} 轮 · {count} 条（整体折叠）',
      'panel.groupCollapsed': '已折叠（点右侧 + 展开这 10 条）',
      'panel.groupExpanded': '已展开（点右侧 − 收起这 10 条）',
      'panel.foldExpand': '展开更早的轮次',
      'panel.foldCollapse': '折叠更早的轮次',
      'panel.staleHost': '宿主版本较旧 · 请重启应用',
      'panel.foldHide': '收起较早的轮次',
      'panel.checkpoints': '个检查点',
      'panel.roots': '覆盖工作区',
      'panel.rootsValue': '{count} 个',
      'notice.compacted': '这一段历史已被对话压缩（compaction）折叠，不属于本插件的回退范围。',
      'notice.promptReplaced': '该轮的用户消息已被外壳的系统提示更新替换（system prompt 以 in-history 方式投递时会发生），不属于本插件的回退范围。',
      'notice.replacedByOther': '这一段历史已被其它插件或流程替换，本插件不再改动它。',
      'state.loading': '正在读取检查点…',
      'state.noSession': '当前没有打开的会话。',
      'state.noCheckpoints': '还没有检查点。每一轮对话结束后会自动建立，也可以点「立即创建检查点」。',
      'state.notLive': '该会话不在本进程中打开，只能查看。',
      'notice.confirmTitle': '确认回退',
      'notice.forkExplain': '会派生一个新会话（只包含该检查点之前的对话）并切换过去，当前会话完整保留为旁支。',
      'notice.inplaceExplain': '在当前会话内追加一次历史遮蔽：模型将不再看到被回退的内容，但聊天记录仍然保留，并作为「已废弃分支」显示在树图上。',
      'notice.workspaceExplain': '会把工作区文件恢复到该检查点的内容：改写已修改的文件、恢复被删除的文件、删除此后新建的文件。执行前会自动建立「回滚前备份」。',
      'notice.safety': '回滚前会自动建立备份检查点，可以再回滚回去。',
      'notice.restartHint': '回退对话后，本面板的树图会立即刷新。',
      'notice.abandonedWarn': '注意：就地遗忘不会改变聊天窗口里已经显示的内容。',
      'notice.noManifest': '该检查点只有对话记录，没有文件快照，无法回滚文件。',
      'notice.noFork': '该检查点无法派生分支（它之后还没有完成的轮次）。',
      'notice.noNextTurn': '该检查点之后还没有新的对话轮次，暂时只能回滚文件。',
      'notice.noPromptTurn': '下一轮不是你发起的（自动续轮 / goal 轮），无法作为回退目标；它之后的那一轮才可以。',
      'notice.unreachable': '该轮已被回退遮蔽、不在模型可见历史里，所以就地回退没有可切的点。',
      'notice.branchHint': '可以点「新分支回退」从这一轮另开一支，把这几轮完整带回来。',
      'toast.snapshotting': '正在建立检查点…',
      'toast.snapshotDone': '检查点已建立',
      'toast.applying': '正在回退…',
      'toast.done': '回退完成',
      'toast.gcDone': '清理完成',
      'summary.restored': '改写',
      'summary.recreated': '恢复',
      'summary.deleted': '删除',
      'summary.failed': '失败',
      'summary.files': '个文件',
      'trigger.title': '对话回退',
    }
    const en = {
      'action.refresh': 'Refresh',
      'action.snapshot': 'Checkpoint now',
      'action.gc': 'Collect unused data',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.confirm': 'Confirm',
      'action.running': 'Working…',
      'action.retry': 'Retry',
      'action.gotIt': 'Got it',
      'action.dismiss': 'Dismiss this notice',
      'notice.reaskCodeViaAgent': 'Roll back the code and ask again (applies next turn)',
      'notice.inplaceCodeViaAgent': 'Roll back the code and forget the conversation (applies next turn)',
      'action.reaskCode': 'Roll back the code and ask again',
      'action.rewindHere': 'Rewind here',
      'action.inplaceCode': 'Roll back the code and forget the conversation',
      'notice.scheduled': 'Rollback scheduled: it runs when the next turn opens (the session log can only be written from inside an open turn).',
      'notice.scheduledReask': 'Files restored; the conversation rollback runs as this turn opens, and your prompt has been sent.',
      'notice.agentExplain': 'While the conversation is idle the panel cannot write the session log safely (a rewind marker must sit inside an open turn/step), so the rollback is applied automatically when the next turn opens. Only your own prompt is sent — no internal instruction appears in the chat.',
      'notice.bothViaAgent': 'Roll back the code and conversation, then ask again (applies next turn)',
      'notice.reaskViaAgent': 'Rewind and ask again (applies next turn)',
      'notice.inplaceViaAgent': 'Forget in place (applies next turn)',
      'action.fork': 'Rewind conversation (new branch)',
      'action.inplace': 'Rewind conversation (forget in place)',
      'action.workspace': 'Roll back workspace files',
      'action.both': 'Rewind everything (branch + files)',
      'action.bothInplace': 'Rewind everything (in place + files)',
      'action.restoreSafety': 'Restore this backup',
      'action.openBranch': 'Open that branch',
      'settings.title': 'Conversation rewind',
      'panel.title': 'Conversation rewind / workspace rollback',
      'panel.legend.current': 'current branch',
      'panel.legend.abandoned': 'abandoned branch',
      'panel.legend.snapshot': 'file snapshot',
      'panel.legend.conversationOnly': 'conversation only',
      'panel.legend.safety': 'pre-rollback backup',
      'panel.turn': 'Turn',
      'panel.turnZero': 'Start',
      'panel.inherited': ' (inherited from parent branch)',
      'detail.title': 'Checkpoint',
      'detail.close': 'Hide details',
      'action.reask': 'Rewind and ask again',
      'detail.promptEdited': 'prompt edited',
      'notice.reaskShort': 'Undoes this turn and sends the prompt above again.',
      'detail.promptHint': 'Edit this prompt directly; Enter inserts a newline and triggers nothing else.',
      'notice.reaskExplain': 'Undoes this turn (the model no longer sees it), then puts your edited prompt in the composer and sends it as a new turn; the log and the tree keep the original.',
      'notice.reaskConfirm': 'Will rewind to before that turn and start a new turn with the prompt above; the original stays in the log and the tree.',
      'notice.reaskEmpty': 'The prompt cannot be empty.',
      'notice.reaskNoComposer': 'The composer is not reachable (the session seat is not mounted); the rewind happened but nothing was sent — paste the prompt manually.',
      'notice.queued': 'The agent is working, so this rewind is queued and will run as soon as it is free — the panel keeps a record either way.',
      'notice.queuedDone': 'The queued rewind finished',
      'notice.queuedFailed': 'The queued rewind failed',
      'notice.queuedPending': 'Queued: it will rewind when this turn ends',
      'action.cancelQueued': 'Cancel the queued rewind',
      'detail.none': 'Select a node in the tree.',
      'detail.turn': 'Turn',
      'detail.time': 'Time',
      'detail.kind': 'Kind',
      'detail.files': 'Files',
      'usage.tokens': 'tokens',
      'usage.tools': 'tools',
      'usage.title': 'This turn',
      'usage.input': 'input',
      'usage.output': 'output',
      'usage.cacheRead': 'cache read',
      'usage.total': 'total',
      'usage.steps': 'steps',
      'usage.duration': 'took',
      'usage.toolCalls': 'tool calls',
      'usage.model': 'model',
      'detail.prompt': 'Prompt of that turn',
      'detail.dropped': 'Will drop',
      'detail.droppedTurns': 'turns',
      'detail.stats': 'Snapshot',
      'detail.branch': 'Branch',
      'detail.forkAt': 'Branch anchor',
      'kind.auto': 'automatic',
      'kind.manual': 'manual',
      'kind.history': 'historical (no file snapshot)',
      'kind.safety': 'pre-rollback backup',
      'badge.current': 'current',
      'badge.newBranch': 'after rewind',
      'badge.deadBranch': 'abandoned',
      'badge.rewound': 'rewound',
      'badge.compacted': 'compacted',
      'badge.replaced': 'replaced',
      'badge.promptReplaced': 'prompt updated',
      'badge.conversationOnly': 'chat only',
      'badge.safety': 'backup',
      'panel.autoSelected': 'auto-selected the most recently active session',
      'panel.selectHint': 'select a checkpoint for details',
      'panel.groupRow': '{from} – {to} · {count} rows',
      'panel.groupCollapsed': 'Folded (press + on the right to open these 10)',
      'panel.groupExpanded': 'Expanded (press − on the right to fold these 10)',
      'panel.foldExpand': 'Expand the older turns',
      'panel.foldCollapse': 'Fold the older turns away',
      'panel.staleHost': 'Host half is older · restart the app',
      'panel.foldHide': 'Fold the older turns away',
      'panel.checkpoints': 'checkpoints',
      'panel.roots': 'Workspaces covered',
      'panel.rootsValue': '{count}',
      'notice.compacted': 'This range was folded away by conversation compaction; it is not something this plugin rewound.',
      'notice.promptReplaced': "This turn's user message was replaced by the shell's in-history system-prompt update; it is not something this plugin rewound.",
      'notice.replacedByOther': 'This range was replaced by another plugin or flow, and this plugin will not touch it.',
      'state.loading': 'Loading checkpoints…',
      'state.noSession': 'No session is open.',
      'state.noCheckpoints': 'No checkpoints yet. One is taken automatically after every turn, or press "Checkpoint now".',
      'state.notLive': 'This session is not open in this process; it is read-only here.',
      'notice.confirmTitle': 'Confirm rollback',
      'notice.forkExplain': 'A new session is forked from the history before this checkpoint and opened; the current session stays intact as a sibling branch.',
      'notice.inplaceExplain': 'A surface replacement is appended to this session: the model no longer sees the rewound content, while the chat transcript keeps it and the tree shows it as an abandoned branch.',
      'notice.workspaceExplain': 'Workspace files are restored to this checkpoint: modified files are rewritten, deleted files come back, and files created since are removed. A pre-rollback backup is taken first.',
      'notice.safety': 'A backup checkpoint is taken automatically before the rollback, so it can be undone.',
      'notice.restartHint': 'The tree refreshes as soon as the rollback lands.',
      'notice.abandonedWarn': 'Note: forgetting in place does not change what the chat window already shows.',
      'notice.noManifest': 'This checkpoint has no file snapshot, so files cannot be rolled back.',
      'notice.noFork': 'This checkpoint cannot fork: no completed turn follows it.',
      'notice.noNextTurn': 'No new turn has started after this checkpoint yet, so only files can be rolled back.',
      'notice.noPromptTurn': 'The next turn was not started by you (an auto-continued or goal round), so it cannot anchor a rewind; a later turn can.',
      'notice.unreachable': 'That turn is shadowed and no longer in the model-visible history, so an in-place rewind has nothing to cut at.',
      'notice.branchHint': 'Use the branch rewind to fork from this row and bring those turns back in full.',
      'toast.snapshotting': 'Taking a checkpoint…',
      'toast.snapshotDone': 'Checkpoint created',
      'toast.applying': 'Rolling back…',
      'toast.done': 'Rollback complete',
      'toast.gcDone': 'Cleanup complete',
      'summary.restored': 'rewritten',
      'summary.recreated': 'restored',
      'summary.deleted': 'deleted',
      'summary.failed': 'failed',
      'summary.files': 'files',
      'trigger.title': 'Rewind',
    }
    const dictionaries = { zh, en }
    const localLang = () => {
      const lang = globalThis.document?.documentElement?.lang
      return typeof lang === 'string' && lang.startsWith('en') ? 'en' : 'zh'
    }
    /** Local dictionary lookup, used when the shell locale service is absent. */
    const localT = (key, params) => {
      const table = dictionaries[localLang()] ?? zh
      const template = table[key] ?? zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    }

    /**
     * The translator every surface uses.
     *
     * It is deliberately NOT the slot's injected `t` prop: a slot's `t` resolves
     * against whatever namespace the shell bound for that seat, and in this
     * deployment that namespace does not carry these keys — the panel then
     * renders raw ids such as `panel.title`. Binding the plugin's own namespace
     * keeps the copy owned by the plugin, with the bundled dictionary as the
     * fallback whenever the locale service is absent or misses a key.
     */
    let translate = localT
    function bindTranslator(ctx) {
      const locale = ctx.get('locale')
      if (locale === undefined) return
      try {
        if (typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          translate = (key, params) => {
            const value = bound(key, params)
            return typeof value === 'string' && value !== key ? value : localT(key, params)
          }
          return
        }
      } catch {
        /* fall through to the bundled dictionary */
      }
      translate = localT
    }
    const t = (key, params) => translate(key, params)

    /**
     * The active session id as reported by a session-scoped slot.
     *
     * `ctx.get('sessions')` is the primary source, but a shell whose list store
     * has not bound yet reports nothing there. Every session-scoped registration
     * receives the session id, so the invisible trigger below records it as a
     * second, independent source.
     */
    let slotSessionId
    const slotSessionListeners = new Set()
    const noteSlotSession = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '' || slotSessionId === sessionId) return
      slotSessionId = sessionId
      for (const listener of [...slotSessionListeners]) listener()
    }
    const subscribeSlotSession = (listener) => {
      slotSessionListeners.add(listener)
      return () => { slotSessionListeners.delete(listener) }
    }

    /**
     * Put a prompt in the composer and send it.
     *
     * The composer applies a draft on its own next render, so calling `submit()` in
     * the same tick sent whatever was in the box BEFORE this prompt — or nothing at
     * all. Set the draft, give the composer a couple of frames, set it again (in case
     * that render cleared it), then submit.
     *
     * @returns whether the text was handed to a composer at all.
     */
    function submitPrompt(actions, text) {
      if (actions === undefined) return Promise.resolve(false)
      const set = typeof actions.setDraft === 'function'
      if (set) actions.setDraft(text)
      if (set && typeof actions.submit !== 'function') return Promise.resolve(true)
      if (!set && typeof actions.submit !== 'function') return Promise.resolve(false)
      return new Promise((resolve) => {
        setTimeout(() => {
          if (set) actions.setDraft(text)
          actions.submit()
          resolve(true)
        }, 80)
      })
    }
    /**
     * Per-session composer input actions, captured from a session-scoped slot.
     *
     * `InputActions` is the documented public input face for session-scope slots
     * (`setDraft` / `submit`), and it is the only supported way for a plugin to
     * put text in the composer and send it. Captured per session id so picking a
     * checkpoint on another branch still addresses the right composer.
     */
    const inputActionsBySession = new Map()
    const noteInputActions = (sessionId, actions) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (actions === undefined || actions === null) return
      if (typeof actions.setDraft !== 'function' && typeof actions.submit !== 'function') return
      inputActionsBySession.set(sessionId, actions)
    }
    const inputActionsFor = (sessionId) => (sessionId === undefined ? undefined : inputActionsBySession.get(sessionId))

    // ───────────────────────────────────────────────────────────────────────
    // transport
    // ───────────────────────────────────────────────────────────────────────
    const ROUTE = '/dsh-rewind/rpc'
    /** How long a request may hang before the panel gives up on it. */
    const RPC_TIMEOUT_MS = 20000
    /**
     * POST one JSON envelope; never throws.
     *
     * The timeout matters: a request that never settles used to leave the panel's
     * busy flag set, which is exactly how the confirm button turned grey and
     * stayed grey. Failing loudly at least returns the UI to a usable state.
     */
    async function rpc(method, params) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The host records this so a stale bundle can be told apart from a bug.
          body: JSON.stringify({ method, params: params ?? {}, client: BUILD_ID }),
          signal: controller?.signal,
        })
      } catch (error) {
        const aborted = controller !== undefined && controller.signal.aborted
        return {
          ok: false,
          error: {
            code: aborted ? 'timeout' : 'transport',
            message: aborted
              ? `回退服务在 ${Math.round(RPC_TIMEOUT_MS / 1000)} 秒内没有响应（操作可能仍在后台进行，请刷新看看）`
              : `回退服务不可达：${String(error)}`,
          },
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      try {
        const envelope = await response.json()
        if (typeof envelope !== 'object' || envelope === null) {
          return { ok: false, error: { code: 'transport', message: '回退服务返回了非法响应' } }
        }
        if (envelope.ok === true) return { ok: true, value: envelope.value }
        return { ok: false, error: envelope.error ?? { code: 'internal', message: '未知错误' } }
      } catch (error) {
        return { ok: false, error: { code: 'transport', message: `回退服务响应解析失败：${String(error)}` } }
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // small shared state: the overlay is opened from the sidebar button
    // ───────────────────────────────────────────────────────────────────────
    const overlayState = { open: false, listeners: new Set() }
    const subscribeOverlay = (listener) => {
      overlayState.listeners.add(listener)
      return () => { overlayState.listeners.delete(listener) }
    }
    const setOverlay = (open) => {
      if (overlayState.open === open) return
      overlayState.open = open
      for (const listener of [...overlayState.listeners]) listener()
    }
    const toggleOverlay = () => setOverlay(!overlayState.open)
    /** Local React store bridge; avoids depending on any state library. */
    function useOverlayOpen() {
      const [open, setOpen] = React.useState(overlayState.open)
      React.useEffect(() => subscribeOverlay(() => setOpen(overlayState.open)), [])
      return open
    }

    // ───────────────────────────────────────────────────────────────────────
    // formatting helpers
    // ───────────────────────────────────────────────────────────────────────
    /** Last two path segments, e.g. 
ewind/v1, for a compact footer. */
    const storeLabel = (root) => {
      if (typeof root !== 'string' || root === '') return ''
      const parts = root.split(/[\\/]+/).filter((part) => part !== '')
      return parts.slice(-2).join('/')
    }
    const shorten = (text, limit) => {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (flat.length <= limit) return flat
      return `${flat.slice(0, Math.max(1, limit - 1))}…`
    }

    /**
     * Approximate rendered width of one code point at a font size.
     *
     * SVG text neither wraps nor clips, so a browser draws an over-long label
     * straight past the node edge — how a Chinese prompt used to bleed out of
     * its box. Measuring by character class keeps every label inside its shape.
     */
    function charWidth(code, fontSize) {
      if (code === undefined) return fontSize * 0.56
      if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) || code >= 0x1f300) return fontSize
      return fontSize * 0.56
    }

    /** Truncate text to fit a pixel width, ending with an ellipsis when cut. */
    function fitText(text, maxWidth, fontSize) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      const chars = [...flat]
      let width = 0
      let count = 0
      for (const character of chars) {
        const advance = charWidth(character.codePointAt(0), fontSize)
        if (width + advance > maxWidth) break
        width += advance
        count += 1
      }
      if (count >= chars.length) return flat
      const ellipsis = charWidth(0x2026, fontSize)
      while (count > 0 && width + ellipsis > maxWidth) {
        count -= 1
        width -= charWidth(chars[count].codePointAt(0), fontSize)
      }
      return `${chars.slice(0, count).join('')}…`
    }
    const formatBytes = (bytes) => {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
      return `${(bytes / 1073741824).toFixed(2)} GB`
    }
    const formatTime = (value) => {
      if (typeof value !== 'number') return '-'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }
    /**
     * A compact clock for the right-hand time rail. The left gutter prints a short
     * turn label, so this must be short too: same day as the reference (the usual
     * case) is `HH:MM`, a row from another day carries its date as well.
     */
    const formatClock = (value, reference) => {
      if (typeof value !== 'number') return ''
      const at = new Date(value)
      const same = typeof reference === 'number' && reference > 0
        && new Date(reference).toDateString() === at.toDateString()
      const pad = (number) => String(number).padStart(2, '0')
      const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
      return same ? clock : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`
    }
    const turnLabel = (afterTurn, t) => {
      if (afterTurn === undefined || afterTurn === null) return '-'
      if (afterTurn === 0) return t('panel.turnZero')
      if (Number.isInteger(afterTurn)) return `${t('panel.turn')} ${afterTurn}`
      return `${t('panel.turn')} ${Math.floor(afterTurn)}+`
    }

    // ───────────────────────────────────────────────────────────────────────
    // tree layout (pure)
    //
    // The graph reads as a git log: a narrow rail column on the left holds one
    // rail per branch, a turn gutter names each row, and every checkpoint is a
    // full-width row card. Cards fill the available width, so the panel never
    // shows a small box floating in a large empty field.
    // ───────────────────────────────────────────────────────────────────────
    const ROW_H = 54
    const CARD_H = 46
    const GUTTER_W = 64
    const LANE_STEP = 26
    const RAIL_INSET = 12
    const CARD_GAP = 16
    const LANE_HEADER_H = 34
    const TOP_PAD = LANE_HEADER_H + 14
    const BOTTOM_PAD = 22
    const MIN_CARD_W = 240
    /** Room the title and prompt keep: the figures may use whatever is left. */
    const MIN_TEXT_ROOM = 260
    /**
     * The right-hand time gutter, the mirror of the left turn gutter: a 12px rail
     * gap, the label 16px past it (the left gutter's own gap) and the +/− control
     * after that. Reserved off the canvas before the cards are laid out.
     */
    const TIME_GUTTER_W = 112
    /** Left inset of the whole timeline, so it never hugs the panel edge. */
    const GRAPH_PAD = 20
    /**
     * A row card stops growing here. Set well above any real panel so the cards fill
     * the width they are given — the time gutter, not a cap, is what ends the row.
     */
    const MAX_CARD_W = 4000
    const DEFAULT_GRAPH_W = 620
    /** Left padding inside a row card. */
    const CARD_PAD = 14
    /** Widest a branch chip's text may be before it is ellipsised. */
    /** Rows shown before the timeline folds the older ones away. */
    const COLLAPSE_LIMIT = 10
    /** Stable empty set, so a default fold state costs no allocation per render. */
    const EMPTY_GROUP_SET = new Set()

    const byCreated = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)

    /** A short, stable display name for a session id. */
    const shortSession = (id) => {
      const text = String(id ?? '')
      const tail = text.replace(/^session-/, '')
      return tail.length > 10 ? tail.slice(0, 8) : tail || text
    }

    /**
     * Lay the checkpoint timeline out for a given graph width.
     *
     * Rows are consecutive slots over the visible entries (one per checkpoint, in
     * turn order), NOT the raw turn number: a folded range therefore leaves no
     * blank space behind it, and two checkpoints recorded at the same turn (an
     * automatic one and a manual one) no longer overlap. The turn number is still
     * what the gutter prints.
     *
     * Rail columns are branches, assigned in depth-first order so a fork always
     * opens to the right of its parent.
     *
     * @param sessions - the conversation's fork family.
     * @param checkpoints - the visible checkpoints of that family.
     * @param options - `{ width }` is the graph viewport width in pixels.
     * @returns nodes, edges, lanes, rows, the rail geometry, and the canvas size.
     */
    function buildLayout(sessions, checkpoints, options = {}) {
      const width = Math.max(MIN_CARD_W + GUTTER_W + LANE_STEP + CARD_GAP,
        Math.round(options.width ?? DEFAULT_GRAPH_W))
      const sessionById = new Map(sessions.map((session) => [session.id, session]))
      const childrenOf = new Map()
      for (const session of sessions) {
        const key = session.parentSession ?? ''
        if (!childrenOf.has(key)) childrenOf.set(key, [])
        childrenOf.get(key).push(session)
      }
      const laneOf = new Map()
      let lane = 0
      const visit = (session) => {
        if (laneOf.has(session.id)) return
        laneOf.set(session.id, lane)
        lane += 1
        for (const child of (childrenOf.get(session.id) ?? []).slice().sort(byCreated)) visit(child)
      }
      const roots = sessions.filter((session) => session.parentSession === undefined
        || !sessionById.has(session.parentSession))
      for (const root of roots.slice().sort(byCreated)) visit(root)
      for (const session of sessions.slice().sort(byCreated)) visit(session)

      const bySession = new Map()
      for (const checkpoint of checkpoints) {
        // Block headers are not rows: they borrow their lane from the rows they
        // stand in for and must stay out of the dead-run/fork classification.
        if (checkpoint.__group === true) continue
        if (!bySession.has(checkpoint.sessionId)) bySession.set(checkpoint.sessionId, [])
        bySession.get(checkpoint.sessionId).push(checkpoint)
      }
      for (const list of bySession.values()) list.sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0))

      // ── surface forks ─────────────────────────────────────────────────────
      // A rewind folds a run of turns away; if a new turn followed it (an
      // edit-and-re-ask), the model-visible history forked even though the log
      // stayed linear. That fork must be visible: the abandoned run keeps its
      // lane as grey dead wood, and the live continuation moves to a new lane
      // reached by a connector from the last live row before the cut.
      let laneCountBase = lane
      // "Rewound away" is `abandoned` on its own. An older host also set
      // `alreadyRewound`, and requiring it meant NOTHING classified as dead on the
      // current host: no dashed run, no cut, no fork — the whole conversation drew
      // as one solid branch. `ownTurnRewound` still wins when present.
      const deadOf = (checkpoint) => checkpoint.ownTurnRewound === true
        || checkpoint.abandoned === true
      const forks = []
      for (const [sessionId, list] of bySession) {
        // ONE FORK PER CUT, not one per session. Several rewinds in one conversation
        // are several cuts, and lumping them into a single fork anchored at the first
        // one drew an elbow from turn 1 straight to the newest row — the rail then
        // read as "2–15 is the new branch" instead of its real shape:
        //
        //   2–7 (abandoned) · 8 9 (kept) · 10–15 (abandoned) · 16+ (new branch)
        //
        // Where the host reports each rewind's turn range (`session.cuts`) that is
        // authoritative: the cumulative `abandoned` flag cannot say where a cut was.
        // Without it, contiguous runs of abandoned rows are the best available split.
        const sessionCuts = sessionById.get(sessionId)?.cuts
        const runs = []
        if (Array.isArray(sessionCuts) && sessionCuts.length > 0) {
          for (const cut of sessionCuts) {
            // A checkpoint at `afterTurn = N` stands for the boundary after turn N,
            // and the rewind cut at turn T is that boundary's row (T - 1).
            const rows = list.filter((checkpoint) => {
              const turn = checkpoint.afterTurn ?? 0
              return turn >= (cut.fromTurn ?? 0) - 1 && turn <= (cut.toTurn ?? 0) - 1
            })
            if (rows.length > 0) runs.push(rows)
          }
        } else {
          let run = []
          for (const checkpoint of list) {
            if (deadOf(checkpoint)) {
              run.push(checkpoint)
              continue
            }
            if (run.length > 0) runs.push(run)
            run = []
          }
          if (run.length > 0) runs.push(run)
        }
        for (const [runIndex, deadRun] of runs.entries()) {
          const firstDeadTurn = deadRun[0].afterTurn ?? 0
          const anchor = list.filter((checkpoint) => (checkpoint.afterTurn ?? 0) < firstDeadTurn
            && !deadOf(checkpoint)).slice(-1)[0]
          // The live rows this cut produced run until the NEXT cut: rows after a
          // later abandoned run belong to that cut's fork instead.
          const nextDeadTurn = runs[runIndex + 1] === undefined
            ? undefined
            : (runs[runIndex + 1][0].afterTurn ?? 0)
          const live = list.filter((checkpoint) => (checkpoint.afterTurn ?? 0) > firstDeadTurn
            && !deadOf(checkpoint)
            && (nextDeadTurn === undefined || (checkpoint.afterTurn ?? 0) < nextDeadTurn))
          if (anchor === undefined || live.length === 0) continue
          forks.push({
            sessionId,
            anchor,
            live,
            dead: deadRun,
            // A fresh column to the right of every existing one, so no cut collides
            // with another lane.
            column: laneCountBase,
          })
          laneCountBase += 1
        }
      }
      // A checkpoint belongs to at most one cut: the one whose live run it starts.
      const forkOfCheckpoint = (checkpoint) => forks.find((fork) =>
        fork.live.some((entry) => entry.id === checkpoint.id))
      const forkColumns = new Set(forks.map((fork) => fork.column))

      // One slot per visible entry, in turn order: consecutive rows, so a folded
      // range leaves nothing behind and same-turn checkpoints stop overlapping.
      const orderedEntries = [...checkpoints].sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0))
      const slotOf = new Map(orderedEntries.map((entry, index) => [entry.id, index]))

      const nodes = checkpoints.map((checkpoint) => {
        const fork = forkOfCheckpoint(checkpoint)
        const onNewBranch = fork !== undefined
          && fork.live.some((entry) => entry.id === checkpoint.id)
        const column = onNewBranch ? fork.column : (laneOf.get(checkpoint.sessionId) ?? 0)
        const row = slotOf.get(checkpoint.id) ?? 0
        return {
          checkpoint,
          column,
          row,
          // The turn this row stands for, for the gutter label.
          turn: checkpoint.afterTurn,
          group: checkpoint.__group === true,
          dead: checkpoint.__group === true ? false : deadOf(checkpoint),
          x: 0,
          y: TOP_PAD + row * ROW_H,
          w: MIN_CARD_W,
          h: CARD_H,
          session: sessionById.get(checkpoint.sessionId),
        }
      })
      const nodeByCheckpoint = new Map(nodes.map((node) => [node.checkpoint.id, node]))

      const edges = []
      for (const [sessionId, list] of bySession) {
        for (let index = 1; index < list.length; index += 1) {
          const from = nodeByCheckpoint.get(list[index - 1].id)
          const to = nodeByCheckpoint.get(list[index].id)
          if (from !== undefined && to !== undefined) {
            edges.push({ kind: 'chain', from, to, sessionId, abandoned: to.checkpoint.abandoned === true })
          }
        }
      }
      for (const session of sessions) {
        // The fork prefix is `inheritedEvents` (normalized by the host across
        // dsh-session revisions); `seedLength` is the 0.1.x header spelling.
        const inherited = typeof session.inheritedEvents === 'number'
          ? session.inheritedEvents
          : session.seedLength
        if (session.parentSession === undefined || typeof inherited !== 'number') continue
        const parentList = bySession.get(session.parentSession) ?? []
        const forkNode = parentList
          .filter((checkpoint) => checkpoint.forkAtSeq === inherited - 1)
          .map((checkpoint) => nodeByCheckpoint.get(checkpoint.id))
          .find((node) => node !== undefined)
        const childList = bySession.get(session.id) ?? []
        const childNode = childList.length === 0 ? undefined : nodeByCheckpoint.get(childList[0].id)
        if (forkNode !== undefined && childNode !== undefined) {
          edges.push({ kind: 'fork', from: forkNode, to: childNode, sessionId: session.id, abandoned: false })
        }
      }
      // The rewound surface fork: the last live row before the cut connects to
      // the first row of the live continuation, which sits in its own lane.
      for (const fork of forks) {
        const from = nodeByCheckpoint.get(fork.anchor.id)
        const to = nodeByCheckpoint.get(fork.live[0].id)
        if (from !== undefined && to !== undefined) {
          edges.push({ kind: 'fork', from, to, sessionId: fork.sessionId, abandoned: false, surface: true })
        }
      }

      const maxColumn = nodes.reduce((max, node) => Math.max(max, node.column), 0)
      const maxRow = nodes.reduce((max, node) => Math.max(max, node.row), 0)
      const laneCount = Math.max(1, maxColumn + 1)
      const railLeft = GRAPH_PAD + GUTTER_W + RAIL_INSET
      const railRight = railLeft + (laneCount - 1) * LANE_STEP
      const minX = railRight + CARD_GAP
      // The cards run from the rail column to the time rail: the right gutter IS the
      // right margin, so a wide panel leaves no empty band beside the rows — the box
      // is as long as the panel allows. On a narrow panel the card's own minimum wins
      // and the rails are what stays clear.
      const cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, width - TIME_GUTTER_W - minX))
      const cardX = minX
      const height = TOP_PAD + (maxRow + 1) * ROW_H - (ROW_H - CARD_H) + BOTTOM_PAD

      // One gutter label per distinct integer row: the turn the row stands for.
      // The gutter prints the turn each slot stands for; a repeat (two checkpoints
      // recorded at the same turn) is left blank instead of repeated.
      const rows = nodes
        .slice()
        .sort((a, b) => a.row - b.row)
        .map((node, index, list) => ({
          row: node.row,
          turn: node.turn,
          /** A block header names its range, not a turn. */
          group: node.group === true,
          repeat: index > 0 && list[index - 1].turn === node.turn,
          y: TOP_PAD + node.row * ROW_H + CARD_H / 2,
        }))

      // One rail (and chip) per lane that actually holds nodes. A surface fork
      // splits one session across two lanes, so lanes are derived from the nodes
      // rather than from the sessions.
      const lanes = []
      for (const column of [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b)) {
        const columnNodes = nodes.filter((node) => node.column === column)
        const sessionId = columnNodes[0].checkpoint.sessionId
        const session = sessionById.get(sessionId)
        const title = session?.title === undefined || session.title === ''
          ? shortSession(sessionId)
          : session.title
        // A lane is a "new branch" when a rewind cut put rows on its own column.
        const isNewBranch = forkColumns.has(column)
        const deadCount = columnNodes.filter((node) => node.dead === true).length
        lanes.push({
          sessionId,
          column,
          label: title,
          chip: `${isNewBranch ? `${t('badge.newBranch')} · ` : ''}${title} · ${columnNodes.length}`
            + `${deadCount > 0 ? ` (${deadCount} ${t('badge.rewound')})` : ''}`,
          // Fork children inherit a prefix: their first rows are the parent's.
          inherited: typeof session?.inheritedEvents === 'number' && session.inheritedEvents > 0,
          count: columnNodes.length,
          live: session?.live === true && !isNewBranch,
          // A lane made entirely of folded-away rows is dead wood: dash it.
          dead: columnNodes.every((node) => node.dead === true),
          newBranch: isNewBranch,
          rewound: deadCount,
        })
      }
      lanes.sort((a, b) => a.column - b.column)

      for (const node of nodes) {
        // Cards all start in the same column, to the right of the turn gutter and
        // every junction dot; only their rail column differs.
        node.x = cardX
        node.w = cardW
        node.h = CARD_H
        node.railX = railLeft + node.column * LANE_STEP
      }

      return {
        nodes,
        edges,
        lanes,
        rows,
        railLeft,
        cardX,
        cardW,
        // The right gutter mirrors the left one: a rail column 12px off the cards,
        // the label 16px past it (the left gutter's own gap), the +/− beyond.
        timeRailX: cardX + cardW + 12,
        timeX: cardX + cardW + 28,
        width,
        height,
        laneCount,
      }
    }

    /** Measured pixel width of a string at a font size. */
    function measureText(text, fontSize) {
      let width = 0
      for (const character of String(text ?? '')) width += charWidth(character.codePointAt(0), fontSize)
      return width
    }

    /**
     * A connector between two rails, as a rounded elbow.
     *
     * Straight runs along one rail are drawn by the rail itself, so this is only
     * ever called for a fork (a child branch leaving its parent).
     */
    function edgePath(edge) {
      const { from, to } = edge
      const fromX = from.railX ?? from.x
      const toX = to.railX ?? to.x
      const fromY = from.y + from.h / 2
      const toY = to.y + to.h / 2
      // A surface fork (rewind, then a new turn) is a curve: it leaves the rewind
      // point downward, sweeps across to the new lane, and arrives at the new node
      // from above. A right-angle elbow would run straight down the dead rail's
      // own column and the two lines would read as one.
      if (edge.surface === true) {
        const bend = Math.max(24, Math.min(64, Math.abs(toY - fromY) / 3))
        return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`
      }
      if (Math.abs(fromX - toX) < 1) return `M ${fromX} ${fromY} L ${toX} ${toY}`
      if (Math.abs(fromY - toY) < 1) return `M ${fromX} ${fromY} L ${toX} ${toY}`
      const radius = 9
      const direction = toY > fromY ? 1 : -1
      return [
        `M ${fromX} ${fromY}`,
        `L ${fromX} ${toY - direction * radius}`,
        `Q ${fromX} ${toY} ${fromX + (toX > fromX ? radius : -radius)} ${toY}`,
        `L ${toX} ${toY}`,
      ].join(' ')
    }

    /** One SVG glyph, drawn as a path so no emoji or icon font is required. */
    function Glyph(props) {
      const { kind, size = 14, color = 'currentColor' } = props
      const paths = {
        branch: 'M4 2v7a3 3 0 0 0 3 3h3M4 2a1.4 1.4 0 1 1 0 2.8A1.4 1.4 0 0 1 4 2Zm0 9.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8ZM12 9.6a1.4 1.4 0 1 1 0 .1Z',
        clock: 'M7 1.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 7 1.6Zm0 1.2a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.4 4v3.3l2.4 1.4.6-.9-1.8-1.1V4Z',
        camera: 'M2 4.4h2.3L5.5 3h3l1.2 1.4H12v6.2H2V4.4Zm5 1.1a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z',
        close: 'M3.3 2.4 7 6.1l3.7-3.7.9.9L7.9 7l3.7 3.7-.9.9L7 7.9l-3.7 3.7-.9-.9L6.1 7 2.4 3.3Z',
        refresh: 'M7 2.2a4.8 4.8 0 1 0 4.6 6.1h-1.3A3.6 3.6 0 1 1 7 3.4c.9 0 1.7.3 2.3.9l-1.4 1.4H11V2.4L9.9 3.5A4.7 4.7 0 0 0 7 2.2Z',
        plus: 'M6.4 2.6h1.2v3.8h3.8v1.2H7.6v3.8H6.4V7.6H2.6V6.4h3.8Z',
        warning: 'M7 1.4 13 12H1L7 1.4Zm-.6 3.8v3.6h1.2V5.2H6.4Zm0 4.4v1.2h1.2V9.6H6.4Z',
        dot: 'M7 4.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z',
        // A folded run: three stacked dots, the usual mark for more content.
        dots: 'M7 2.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM7 5.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM7 9.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
        // An outbound link: a frame with its top-right corner opened.
        external: 'M8.6 1.4h4v4h-1.5V4.2L7.2 8.1 6.1 7l3.9-3.9H8.6V1.4ZM1.4 4.4h4.2v1.5H2.9v5.2h5.2V8.4h1.5v4.2H1.4V4.4Z',
        // The GitHub mark itself (16x16), so the credit reads as GitHub at a
        // glance instead of as a generic "open in a new tab".
        github: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
      }
      const viewBoxes = { github: '0 0 16 16' }
      const drawn = paths[kind] ?? paths.dot
      const shapes = Array.isArray(drawn) ? drawn : [drawn]
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: viewBoxes[kind] ?? '0 0 14 14',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, shapes.map((d, index) => React.createElement('path', { key: index, d, fill: color })))
    }

    // ───────────────────────────────────────────────────────────────────────
    // build identity
    // ───────────────────────────────────────────────────────────────────────
    /**
     * The browser half's build id; must equal `BUILD_ID` in lib/index.js.
     *
     * The halves load independently: a page refresh updates this file, while the
     * host half needs a restart. When they disagree the panel says so, instead of
     * letting a stale half look like a broken feature.
     */
    const BUILD_ID = '2026-10-04.6'
    const PLUGIN_VERSION = '1.0.0'

    // ───────────────────────────────────────────────────────────────────────
    // authorship
    // ───────────────────────────────────────────────────────────────────────
    /** The plugin's author and home, shown in the panel and shipped in metadata. */
    const AUTHOR = {
      name: 'joker123-wpx',
      profile: 'https://github.com/joker123-wpx',
      repository: 'https://github.com/joker123-wpx/Deepseek-Harness-Code-revert',
    }

    // ───────────────────────────────────────────────────────────────────────
    // data hooks
    // ───────────────────────────────────────────────────────────────────────
    /**
     * Read `{ sessionId, cwd }` from every source the shell exposes.
     *
     * Order matters: the sessions list is authoritative when it has bound, and
     * the session-scoped slot is the fallback that still works while it has not.
     * Snapshot shapes differ between shell builds, so the active id is looked for
     * under every name it has been seen under (`current`, `activeId`, `active`,
     * `selected`). Returning `undefined` is fine — the host then picks the most
     * recently active live root session itself.
     */
    function readActiveSession(ctx) {
      const sessions = ctx.get('sessions')
      const snapshot = sessions?.list?.getSnapshot?.() ?? sessions?.list?.snapshot?.()
      const candidates = [snapshot?.current, snapshot?.activeId, snapshot?.active, snapshot?.selected]
      const fromList = candidates.find((value) => typeof value === 'string' && value !== '')
      const sessionId = fromList ?? slotSessionId
      const byId = snapshot?.byId ?? snapshot?.sessions
      const record = sessionId === undefined || byId === undefined
        ? undefined
        : (Array.isArray(byId) ? byId.find((entry) => entry?.id === sessionId) : byId[sessionId])
      const cwd = typeof record?.cwd === 'string'
        ? record.cwd
        : (typeof snapshot?.cwd === 'string' ? snapshot.cwd : undefined)
      return {
        sessions,
        sessionId,
        source: fromList !== undefined ? 'list' : slotSessionId !== undefined ? 'slot' : 'none',
        cwd,
      }
    }

    /** The client services that can announce an active-session change. */
    function sessionTickSources(ctx) {
      const sessions = ctx.get('sessions')
      const sources = []
      for (const candidate of [sessions?.list, sessions]) {
        if (candidate === undefined || candidate === null) continue
        if (typeof candidate.subscribe === 'function') sources.push(candidate.subscribe.bind(candidate))
        if (typeof candidate.onChange === 'function') sources.push(candidate.onChange.bind(candidate))
      }
      // The workspace registry changes when the user switches workspace, which
      // usually switches the session with it; the frame-wide host emits a DOM
      // event for focus changes, and the slot probe covers the rest.
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof registry.subscribe === 'function') {
        sources.push(registry.subscribe.bind(registry))
      }
      return sources
    }

    /**
     * Follow the shell's active session.
     *
     * Subscriptions are the fast path but not a guarantee: switching workspace or
     * session window does not always notify a third-party plugin, and a stale
     * panel is worse than a redundant read. So this also re-reads on a short
     * interval, on window focus, and when the tab becomes visible again.
     */
    function useActiveSession(ctx, options = {}) {
      const [state, setState] = React.useState(() => readActiveSession(ctx))
      const intervalMs = options.intervalMs ?? 1200
      React.useEffect(() => {
        setState(readActiveSession(ctx))
        const sync = () => setState(readActiveSession(ctx))
        const disposers = sessionTickSources(ctx).map((subscribe) => subscribe(sync))
        disposers.push(subscribeSlotSession(sync))
        const handle = setInterval(sync, intervalMs)
        const onFocus = () => sync()
        const onVisible = () => { if (globalThis.document?.visibilityState !== 'hidden') sync() }
        globalThis.addEventListener?.('focus', onFocus)
        globalThis.document?.addEventListener?.('visibilitychange', onVisible)
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose()
          clearInterval(handle)
          globalThis.removeEventListener?.('focus', onFocus)
          globalThis.document?.removeEventListener?.('visibilitychange', onVisible)
        }
      }, [ctx, intervalMs])
      return state
    }

    /**
     * Track an element's content width, so the timeline can fill it.
     *
     * The observed box changes height whenever the timeline folds, which fires the
     * observer; only a real width change is accepted, and the stylesheet reserves
     * a stable scrollbar gutter so a fold cannot make the width oscillate.
     *
     * Server rendering (tests, the offline preview) has no layout engine: the
     * effect never runs and the fallback width is used.
     */
    function useMeasuredWidth(ref, fallback, revision) {
      const [width, setWidth] = React.useState(fallback)
      // `revision` re-runs the measurement: the panel is laid out while closed (the
      // layer is never unmounted), so a first measurement can be taken before the
      // drawer has its final width and then never refreshed — which is how the
      // timeline ended up narrower than the panel it sits in.
      React.useEffect(() => {
        const element = ref.current
        if (element === undefined || element === null) return undefined
        let frame
        const measure = () => {
          const next = Math.round(element.clientWidth)
          // 8px of slack: a scrollbar or a rounding wobble must not re-lay out the
          // whole graph, which is what made folding feel stuck.
          if (next > 0) setWidth((previous) => (Math.abs(previous - next) > 8 ? next : previous))
        }
        const measureAfterLayout = () => {
          measure()
          // Once more after the browser has settled the drawer's layout.
          frame = globalThis.requestAnimationFrame?.(measure) ?? setTimeout(measure, 16)
        }
        measure()
        measureAfterLayout()
        if (typeof ResizeObserver !== 'function') {
          globalThis.addEventListener?.('resize', measure)
          return () => {
            globalThis.removeEventListener?.('resize', measure)
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          }
        }
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => {
          observer.disconnect()
          if (typeof cancelAnimationFrame === 'function' && typeof frame === 'number') cancelAnimationFrame(frame)
        }
      }, [ref, revision])
      return width
    }

    /**
     * A cheap fingerprint of an overview payload.
     *
     * Polling every couple of seconds must not rebuild the graph: when the
     * fingerprint is unchanged the previous object is kept, so `layout` (memoized
     * on the payload) is not recomputed and the SVG is not re-rendered at all.
     */
    function overviewSignature(data) {
      if (data === undefined || data === null) return ''
      const checkpoints = (data.checkpoints ?? [])
        .map((entry) => [
          entry.id, entry.afterTurn, entry.manifest === true ? 1 : 0,
          entry.alreadyRewound === true ? 1 : 0, entry.ownTurnRewound === true ? 1 : 0,
          entry.compacted === true ? 1 : 0, entry.promptReplaced === true ? 1 : 0,
          entry.replacedByOther === true ? 1 : 0, entry.reachable === true ? 1 : 0,
          entry.canFork === true ? 1 : 0, entry.hasNextTurn === true ? 1 : 0,
        ].join(':'))
        .join('|')
      const sessions = (data.sessions ?? []).map((session) => `${session.id}:${session.title ?? ''}`).join('|')
      const queue = data.queue ?? {}
      return [
        data.currentSessionId ?? '',
        data.cwd ?? '',
        (data.roots ?? []).length,
        sessions,
        checkpoints,
        queue.pending === undefined ? '' : `${queue.pending.checkpointId}@${queue.pending.queuedAt}`,
        queue.last === undefined ? '' : `${queue.last.checkpointId}@${queue.last.at}:${queue.last.ok === true ? 1 : 0}`,
        data.build?.host ?? '',
      ].join('§')
    }

    /** Load the tree payload, refreshing while the panel is visible. */
    function useOverview(sessionId, options = {}) {
      const [state, setState] = React.useState({ loading: false, data: undefined, error: undefined })
      const refreshMs = options.refreshMs ?? 2000
      const active = options.active !== false
      const load = React.useCallback(async (options2 = {}) => {
        // Only a foreground load shows the spinner; a background poll must not
        // repaint the panel twice per tick.
        if (options2.quiet !== true) setState((previous) => ({ ...previous, loading: true }))
        // No session id is fine: the host then picks the most recently active live
        // root session and reports it back in `currentSessionId`. The measured graph
        // width rides along so the host's call log can show what the panel actually
        // had to draw into.
        const response = await rpc('overview', sessionId === undefined
          ? { graphWidth: options2.graphWidth }
          : { sessionId, graphWidth: options2.graphWidth })
        setState((previous) => {
          if (response.ok !== true) {
            return { loading: false, data: undefined, error: response.error }
          }
          const next = response.value
          // Identical payload: keep the previous object identity so nothing
          // downstream re-renders.
          if (overviewSignature(next) === overviewSignature(previous.data)) {
            return previous.loading === false && previous.error === undefined
              ? previous
              : { loading: false, data: previous.data, error: undefined }
          }
          return { loading: false, data: next, error: undefined }
        })
      }, [sessionId])
      const reload = React.useCallback((extra) => load(extra), [load])
      React.useEffect(() => { void load() }, [load])
      // Opening the panel must show the current state, not the last poll's.
      React.useEffect(() => { if (active) void load() }, [active, load])
      React.useEffect(() => {
        if (!active) return undefined
        // Polling keeps the panel honest across workspace and session switches —
        // the shell does not promise to notify a third-party plugin. A hidden
        // window skips the round trip; becoming visible refreshes immediately.
        const tick = () => {
          if (globalThis.document?.visibilityState === 'hidden') return
          void load({ quiet: true })
        }
        const handle = setInterval(tick, refreshMs)
        const onVisible = () => { if (globalThis.document?.visibilityState !== 'hidden') void load({ quiet: true }) }
        globalThis.document?.addEventListener?.('visibilitychange', onVisible)
        return () => {
          clearInterval(handle)
          globalThis.document?.removeEventListener?.('visibilitychange', onVisible)
        }
      }, [load, refreshMs, active])
      return { ...state, reload }
    }

    /**
     * Group a long timeline into foldable blocks of ten.
     *
     * Blocks are cut from the OLDEST end and each block folds as a whole, so a
     * 21-row conversation shows 1 row and hides 20 (two blocks of ten), not a
     * single "everything else" summary. A block shorter than ten rows never folds
     * ("at least ten"), and the very first row is never folded away: it anchors
     * the timeline, so folding starts at the second row.
     *
     * Each block contributes one header row carrying its +/− control (drawn at
     * the row's right edge), followed by its rows when expanded.
     *
     * @param checkpoints - every checkpoint of the conversation.
     * @param expandedGroups - a Set of block start turns the user has opened.
     * @param limit - rows per block (default 10).
     * @returns `{ visible, groups }`: the rows to draw and the block descriptors.
     */
    function groupRows(checkpoints, expandedGroups, limit) {
      const ordered = [...checkpoints].sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0))
      // Fewer rows than one block: nothing folds and every row is shown.
      if (ordered.length <= limit) return { visible: ordered, groups: [] }
      const groups = []
      const rest = ordered.slice(1)
      for (let start = 0; start < rest.length; start += limit) {
        const rows = rest.slice(start, start + limit)
        groups.push({
          index: groups.length,
          count: rows.length,
          // Only a full block folds; a shorter tail stays visible.
          foldable: rows.length === limit,
          from: rows[0].afterTurn,
          to: rows[rows.length - 1].afterTurn,
          rows,
          collapsed: rows.length === limit && !expandedGroups.has(rows[0].afterTurn),
        })
      }
      const visible = [ordered[0]]
      for (const group of groups) {
        if (!group.foldable) {
          visible.push(...group.rows)
          continue
        }
        if (!group.collapsed) {
          // Expanded: NO summary row at all — the block is just its ten ordinary
          // rows, and the − control rides in the right-hand time gutter on the
          // block's first row.
          visible.push({ ...group.rows[0], control: { from: group.rows[0].afterTurn, collapsed: false, count: group.count } })
          visible.push(...group.rows.slice(1))
          continue
        }
        // Collapsed: the whole block folds into ONE row (1–10, 11–20, …) that IS the
        // block's first checkpoint — a real row, so clicking it opens real details
        // and its rewind actions work, with no separate button anywhere. The range it
        // stands for rides along for display, and the + control sits in the gutter.
        visible.push({
          ...group.rows[0],
          folded: { from: group.from, to: group.to, count: group.count },
          control: { from: group.rows[0].afterTurn, collapsed: true, count: group.count },
        })
      }
      return { visible, groups }
    }

    /**
     * Everything the graph needs for one fold state.
     *
     * One pure entry point, so the panel's memo can depend on the values it
     * actually uses and a test can prove the toggle changes the picture. The
     * alternative — memoizing layout on the fetched payload — silently kept the
     * previous graph and made the +/− control look dead.
     */
    function graphFor(sessions, checkpoints, options = {}) {
      const limit = options.limit ?? COLLAPSE_LIMIT
      const { visible, groups } = groupRows(
        checkpoints,
        options.expandedGroups ?? EMPTY_GROUP_SET,
        limit,
      )
      return {
        visible,
        groups,
        layout: buildLayout(sessions, visible, { width: options.width }),
      }
    }

    /**
     * The checkpoint a selection id names, or undefined.
     *
     * Block headers carry ids too (they are rendered as rows), and they are not
     * checkpoints: a selection must never resolve to one, or the details pane
     * would describe a fold control instead of a checkpoint — which is exactly
     * what happened when a block header could be clicked like a row.
     */
    function selectedCheckpointOf(checkpoints, id) {
      if (id === undefined || id === null) return undefined
      return checkpoints.find((checkpoint) => checkpoint.id === id && checkpoint.__group !== true)
    }


    /** A short, human-readable name for a confirmed request, for the footer log. */
    function describeRequest(request) {
      if (request === undefined) return ''
      if (request.reask === true) return 'apply(inplace@anchor) + send'
      const parts = []
      if (request.workspace === 'restore') parts.push('apply(workspace=restore)')
      if (request.conversation === 'inplace') parts.push('apply(conversation=inplace)')
      if (request.conversation === 'fork') parts.push('fork')
      return parts.length === 0 ? 'no-op' : parts.join(' + ')
    }

    /**
     * Carry out one confirmed request.
     *
     * Deliberately outside React: the choreography is the part that kept going
     * wrong (a double rewind, a silent close, a refused-but-invisible apply), and
     * as a plain function it can be driven by tests with a recording transport.
     * The caller owns every piece of state.
     *
     * @param request - the confirmed request: `{ checkpoint, conversation, workspace, reask?, reaskFrom?, text? }`.
     * @param deps - `{ rpc, forkBranch, inputActions, t }`.
     * @returns `{ messages, queued?, reask? }`; throws with the host's message on failure.
     */
    async function executeRequest(request, deps) {
      const { rpc, forkBranch, inputActions, t } = deps
      const checkpoint = request.checkpoint
      const messages = []

      // The workspace restore is independent of the conversation action, so
      // "both" runs it and then a conversation branch below. Everything else is
      // either the re-ask (which rewinds via its own anchor) or exactly ONE
      // conversation action — never two rewinds, which is what used to break the
      // re-ask on the newest turn.
      if (request.workspace === 'restore') {
        const response = await rpc('apply', {
          checkpointId: checkpoint.id,
          conversation: 'none',
          workspace: 'restore',
          confirm: true,
        })
        if (response.ok !== true) throw new Error(response.error.message)
        if (response.value.queued === true) {
          // Mid-turn: the restore waits for the turn boundary, and a re-ask that was
          // part of this request must go out with it rather than be dropped.
          return {
            messages,
            queued: true,
            reask: request.reask === true
              ? { text: String(request.text ?? ''), checkpointId: request.reaskFrom ?? checkpoint.id }
              : undefined,
          }
        }
        const summary = response.value.workspace
        messages.push(`${t('action.workspace')}: ${t('summary.restored')} ${summary.restored}`
          + ` · ${t('summary.recreated')} ${summary.recreated}`
          + ` · ${t('summary.deleted')} ${summary.deleted}`
          + `${summary.failed.length > 0 ? ` · ${t('summary.failed')} ${summary.failed.length}` : ''}`)
        // A workspace-only request has nothing after this: returning here is what
        // makes "roll the files back" finish cleanly. Without it the call fell all
        // the way to the "nothing to run" guard BELOW — after the files had already
        // been restored — so the panel reported a failure for work that succeeded.
        if (request.conversation === 'none' || request.conversation === undefined) {
          if (request.reask !== true) return { messages }
        }
      }

      if (request.reask === true) {
        const anchorId = request.reaskFrom ?? checkpoint.id
        const rewind = await rpc('apply', {
          checkpointId: anchorId,
          conversation: 'inplace',
          workspace: 'none',
          confirm: true,
        })
        if (rewind.ok !== true) throw new Error(rewind.error.message)
        const text = String(request.text ?? '').trim()
        if (text === '') throw new Error(t('notice.reaskEmpty'))
        if (rewind.value.queued === true) {
          // The agent is mid-turn: the rewind waits for the turn boundary, and the
          // prompt goes out when the queue reports it landed.
          return { messages, queued: true, reask: { text, checkpointId: anchorId } }
        }
        messages.push(`${t('action.inplace')}: ${rewind.value.conversation.droppedTurns.length} ${t('detail.droppedTurns')}`)
        if (inputActions === undefined) throw new Error(t('notice.reaskNoComposer'))
        await submitPrompt(inputActions, text)
        messages.push(t('action.reask'))
        return { messages }
      }

      if (request.conversation === 'inplace') {
        const response = await rpc('apply', {
          checkpointId: checkpoint.id,
          conversation: 'inplace',
          workspace: 'none',
          confirm: true,
        })
        if (response.ok !== true) throw new Error(response.error.message)
        if (response.value.queued === true) return { messages, queued: true }
        messages.push(`${t('action.inplace')}: ${response.value.conversation.droppedTurns.length} ${t('detail.droppedTurns')}`)
        return { messages }
      }

      if (request.conversation === 'fork') {
        const result = await forkBranch(checkpoint)
        if (result.ok !== true) throw new Error(result.error.message)
        messages.push(`${t('action.fork')}: ${result.childId}`)
        return { messages }
      }

      // Nothing to do is a bug, not a success: closing the dialog quietly here is
      // exactly what made a click look like it did nothing.
      throw new Error(t('notice.nothingToDo'))
    }

    // ───────────────────────────────────────────────────────────────────────
    // tree component
    // ───────────────────────────────────────────────────────────────────────
    const NODE_FILL = 'var(--rw-bg-3)'
    const NODE_STROKE = 'var(--rw-line)'

    /** One row label in the left gutter: the turn that row stands for. */
    function gutterLabel(row, t) {
      if (row === 0) return t('panel.turnZero')
      return `${t('panel.turn')} ${row}`
    }

    /** State badge under a node label, or an empty string. */
    function nodeState(checkpoint, t) {
      if (checkpoint.kind === 'safety') return t('badge.safety')
      if (checkpoint.alreadyRewound === true) return t('badge.rewound')
      // A row whose own turn is gone (inside an abandoned run) reads as rewound
      // even when a later turn made its next slot live again.
      if (checkpoint.ownTurnRewound === true) return t('badge.rewound')
      if (checkpoint.compacted === true) return t('badge.compacted')
      if (checkpoint.promptReplaced === true) return t('badge.promptReplaced')
      if (checkpoint.replacedByOther === true) return t('badge.replaced')
      if (checkpoint.manifest !== true) return t('badge.conversationOnly')
      return ''
    }

    /** Per-kind stripe colour: snapshot present, chat only, backup, off-branch. */
    const kindColor = (checkpoint) => {
      if (checkpoint.kind === 'safety') return 'var(--rw-warn)'
      if (checkpoint.alreadyRewound === true || checkpoint.ownTurnRewound === true) return 'var(--rw-fg-3)'
      if (checkpoint.compacted === true || checkpoint.promptReplaced === true) return 'var(--rw-warn)'
      if (checkpoint.replacedByOther === true) return 'var(--rw-fg-3)'
      return checkpoint.manifest === true ? 'var(--rw-ok)' : 'var(--rw-accent)'
    }

    /** Snapshot summary for a row's right column, or an empty string. */
    function snapshotInfo(checkpoint, t) {
      if (checkpoint.manifest !== true) return ''
      const files = checkpoint.stats?.files
      if (typeof files !== 'number') return ''
      const size = formatBytes(checkpoint.stats?.bytes)
      return `${files} ${t('detail.files')} · ${size}`
    }

    /** 1234 → "1.2k", so a token count fits on one row card. */
    function formatCount(value) {
      const number = Number(value ?? 0)
      if (!Number.isFinite(number) || number <= 0) return ''
      if (number < 1000) return String(Math.round(number))
      if (number < 1000000) return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)}k`
      return `${(number / 1000000).toFixed(1)}M`
    }

    /** 31284 → "31s"; 95000 → "1m35s". */
    function formatDuration(ms) {
      const total = Math.max(0, Math.round(Number(ms ?? 0) / 1000))
      if (total <= 0) return ''
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
    }

    /**
     * Split a long title into lines that fit a width. Used by the branch chip's
     * reveal, so a truncated title is never unreachable: greedy per character, which
     * is right for the Chinese titles these branches carry.
     *
     * @returns an array of lines, at most maxLines, the last one ellipsised if the
     *   text still does not fit.
     */
    function wrapText(text, maxWidth, fontSize, maxLines) {
      const value = String(text ?? '')
      const lines = []
      let rest = value
      while (rest !== '' && lines.length < maxLines) {
        let cut = rest.length
        while (cut > 1 && measureText(rest.slice(0, cut), fontSize) > maxWidth) cut -= 1
        if (cut >= rest.length) {
          lines.push(rest)
          rest = ''
          break
        }
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      if (rest !== '') {
        lines[lines.length - 1] = fitText(lines[lines.length - 1] + rest, maxWidth, fontSize)
      }
      return lines
    }

    /** Just the two token counts, for the prompt line: the full summary is wider. */
    function usageTokens(checkpoint, t) {
      const usage = checkpoint.usage ?? {}
      const input = formatCount(usage.inputTokens)
      const output = formatCount(usage.outputTokens)
      if (input === '' && output === '') return ''
      return `↑${input || '0'} ↓${output || '0'} ${t('usage.tokens')}`
    }
    /**
     * The per-turn summary shown on a row card.
     *
     * One line by design: what the turn cost (tokens in → out), how much work it did
     * (tool calls, steps) and how long it took. A card has room for a summary, not a
     * table — the details pane breaks the numbers down.
     */
    function usageSummary(checkpoint, t) {
      const usage = checkpoint.usage ?? {}
      const parts = []
      const input = formatCount(usage.inputTokens)
      const output = formatCount(usage.outputTokens)
      // ↑ input, ↓ output — the arrows the panel uses for the two directions.
      if (input !== '' || output !== '') parts.push(`↑${input || '0'} ↓${output || '0'} ${t('usage.tokens')}`)
      if (typeof checkpoint.toolCalls === 'number' && checkpoint.toolCalls > 0) {
        parts.push(`${checkpoint.toolCalls} ${t('usage.tools')}`)
      }
      const duration = formatDuration(checkpoint.durationMs)
      if (duration !== '') parts.push(duration)
      return parts.join(' · ')
    }

    /**
     * The checkpoint timeline.
     *
     * Reading order: the gutter names the turn each row stands for, the rail
     * column carries one continuous rail per branch with a junction dot per
     * checkpoint, and each checkpoint is a full-width row card whose left stripe
     * encodes its kind (snapshot / chat only / backup / off-branch).
     *
     * Selection has exactly ONE signal — the card's accent border and tint. The
     * rail, the dot and the stripe keep encoding structure and kind, so they never
     * read as a second "selected" mark.
     */
    function TreeGraph(props) {
      const { layout, selectedId, currentSessionId, onSelect, t, onToggleGroup } = props
      // Which branch title is revealed. Owned by the panel (this component stays a
      // pure renderer: it is rendered directly, without a hook dispatcher).
      const openChip = props.openChip
      const onToggleChip = typeof props.onToggleChip === 'function' ? props.onToggleChip : () => {}
      if (layout.nodes.length === 0) {
        return React.createElement('div', { className: 'rw-empty' }, t('state.noCheckpoints'))
      }
      const children = []
      const dotY = (node) => node.y + node.h / 2
      const laneNodesOf = (lane) => layout.nodes.filter((node) => node.column === lane.column)

      // ── the fold control: a +/− button at a block header's right edge ──────
      // Blocks fold as whole tens, so the control belongs to the block, not to a
      // row: it sits at the right end of that block's header line.
      const groupButton = (node, collapsed) => {
        if (typeof onToggleGroup !== 'function') return null
        const size = 18
        // The fold control lives in the right-hand TIME gutter, after the times —
        // the mirror of the branch chips that sit above the left rail.
        const x = (layout.timeX ?? node.x + node.w + 28) + 40
        const y = node.y + node.h / 2 - size / 2
        return React.createElement('g', {
          key: `group-${collapsed ? 'open' : 'close'}-${node.row}`,
          className: 'rw-groupbtn',
          role: 'button',
          tabIndex: 0,
          'aria-label': collapsed ? t('panel.foldExpand') : t('panel.foldCollapse'),
          onClick: (event) => {
            event?.stopPropagation?.()
            onToggleGroup(node.checkpoint.control?.from ?? node.checkpoint.folded?.from ?? node.checkpoint.from)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation?.()
              onToggleGroup(node.checkpoint.control?.from ?? node.checkpoint.folded?.from ?? node.checkpoint.from)
            }
          },
        }, [
          React.createElement('rect', {
            key: 'bg',
            x,
            y,
            width: size,
            height: size,
            rx: 4,
            fill: 'var(--rw-bg-2)',
            stroke: 'var(--rw-line-strong)',
            strokeWidth: 1,
          }),
          // A horizontal bar is the minus; adding a vertical one makes the plus.
          React.createElement('rect', {
            key: 'h',
            x: x + 4,
            y: y + size / 2 - 1,
            width: size - 8,
            height: 2,
            rx: 1,
            fill: 'var(--rw-fg-3)',
          }),
          collapsed
            ? null
            : React.createElement('rect', {
              key: 'v',
              x: x + size / 2 - 1,
              y: y + 4,
              width: 2,
              height: size - 8,
              rx: 1,
              fill: 'var(--rw-fg-3)',
            }),
        ].filter(Boolean))
      }

      // ── rails: one line per branch, split wherever a dead run begins ───────
      // A lane holds the live trunk and, after a rewind, a run of dead rows: the
      // trunk stays solid while the folded-away run is dashed and dim, so the
      // point where history was cut is visible on the rail itself.
      for (const lane of layout.lanes) {
        const laneNodes = laneNodesOf(lane).slice().sort((a, b) => a.row - b.row)
        if (laneNodes.length === 0) continue
        const isCurrent = lane.sessionId === currentSessionId
        const runs = []
        let start = 0
        for (let index = 1; index <= laneNodes.length; index += 1) {
          const endsRun = index === laneNodes.length
            || (laneNodes[index].dead === true) !== (laneNodes[start].dead === true)
          if (!endsRun) continue
          runs.push(laneNodes.slice(start, index))
          start = index
        }
        for (const run of runs) {
          const isDead = run[0].dead === true
          children.push(React.createElement('line', {
            key: `rail-${lane.sessionId}-${lane.column}-${run[0].row}`,
            className: isDead ? 'rw-rail rw-rail-dead' : 'rw-rail',
            x1: run[0].railX,
            y1: dotY(run[0]),
            x2: run[run.length - 1].railX,
            y2: dotY(run[run.length - 1]),
            stroke: isDead || lane.newBranch === true || isCurrent ? 'var(--rw-fg-3)' : 'var(--rw-line-strong)',
            strokeWidth: 2,
            strokeLinecap: isDead ? 'butt' : 'round',
            strokeDasharray: isDead ? '4 4' : undefined,
            opacity: isDead ? 0.45 : (lane.newBranch === true || isCurrent ? 0.9 : 0.55),
          }))
        }
      }

      // ── fork elbows: a child branch leaving its parent ────────────────────
      for (const edge of layout.edges) {
        if (edge.kind === 'chain') continue
        // A surface fork (a rewind that was followed by a new turn) is drawn in
        // the live grey, so the eye follows the rewind point straight to the new
        // node instead of reading the two lanes as unrelated.
        const isSurface = edge.surface === true
        children.push(React.createElement('path', {
          key: `e-${edge.from.checkpoint.id}-${edge.to.checkpoint.id}`,
          className: isSurface ? 'rw-fork rw-fork-surface' : 'rw-fork',
          d: edgePath(edge),
          fill: 'none',
          stroke: isSurface ? 'var(--rw-fg-3)' : 'var(--rw-line-strong)',
          strokeWidth: isSurface ? 2.2 : 2,
          strokeLinecap: 'round',
        }))
      }

      // ── right-hand time gutter ───────────────────────────────────────────
      // The mirror of the turn gutter: same rail — a 2px round-capped line with a
      // 1.6px dot per row, split into dim dashed runs wherever the rows were rewound
      // away — and the label 16px past the rail, exactly the left gutter's gap. The
      // left column names the turn, this one names the moment.
      const newestAt = (layout.nodes ?? []).reduce((max, node) => {
        const at = node.checkpoint?.createdAt
        return typeof at === 'number' && at > max ? at : max
      }, 0)
      for (const lane of layout.lanes) {
        const timeNodes = (layout.rows ?? [])
          .map((row) => layout.nodes.find((node) => node.row === row.row))
          .filter((node) => node !== undefined && node.column === lane.column)
          .sort((a, b) => a.row - b.row)
        if (timeNodes.length === 0) continue
        const railX = layout.timeRailX
        const runs = []
        let start = 0
        for (let index = 1; index <= timeNodes.length; index += 1) {
          const endsRun = index === timeNodes.length
            || (timeNodes[index].dead === true) !== (timeNodes[start].dead === true)
          if (!endsRun) continue
          runs.push(timeNodes.slice(start, index))
          start = index
        }
        for (const run of runs) {
          const isDead = run[0].dead === true
          children.push(React.createElement('line', {
            key: `timerail-${run[0].row}`,
            className: isDead ? 'rw-rail rw-timerail rw-rail-dead' : 'rw-rail rw-timerail',
            x1: railX,
            y1: dotY(run[0]),
            x2: railX,
            y2: dotY(run[run.length - 1]),
            stroke: isDead ? 'var(--rw-fg-3)' : 'var(--rw-line-strong)',
            strokeWidth: 2,
            strokeLinecap: isDead ? 'butt' : 'round',
            strokeDasharray: isDead ? '4 4' : undefined,
            opacity: isDead ? 0.45 : 0.55,
          }))
          for (const node of run) {
            children.push(React.createElement('circle', {
              key: `timedot-${node.row}`,
              className: 'rw-dot rw-timedot',
              cx: railX,
              cy: dotY(node),
              r: 1.6,
              opacity: isDead ? 0.45 : 0.8,
            }))
          }
        }
      }
      for (const row of layout.rows) {
        const group = row.group === true
          ? layout.nodes.find((node) => node.row === row.row && node.group === true)
          : undefined
        const node = layout.nodes.find((candidate) => candidate.row === row.row)
        // A compact clock, so this column stays as narrow as the turn labels. Rows
        // from the same day as the newest one print a bare HH:MM.
        const label = group === undefined
          ? formatClock(node?.checkpoint?.createdAt, newestAt)
          : `${group.checkpoint.from}–${group.checkpoint.to}`
        children.push(React.createElement('text', {
          key: `time-${row.row}`,
          x: layout.timeX,
          y: row.y + 4,
          textAnchor: 'start',
          fill: 'var(--rw-fg-3)',
          fontSize: 11,
          fontFamily: 'inherit',
          style: { fontVariantNumeric: 'tabular-nums' },
        }, label))
      }

      // ── turn gutter ───────────────────────────────────────────────────────
      // A block header names its range instead of a turn, so the gutter does not
      // print the fractional sort key the header carries.
      for (const row of layout.rows) {
        const group = row.group === true
          ? layout.nodes.find((node) => node.row === row.row && node.group === true)
          : undefined
        const label = group === undefined
          ? gutterLabel(row.turn, t)
          : `${group.checkpoint.from}–${group.checkpoint.to}`
        children.push(React.createElement('text', {
          key: `gutter-${row.row}`,
          x: GRAPH_PAD + GUTTER_W - 16,
          y: row.y + 4,
          textAnchor: 'end',
          fill: 'var(--rw-fg-3)',
          fontSize: 11,
          fontFamily: 'inherit',
        }, row.repeat === true ? '' : label))
      }



      // ── branch chips, above the rails ─────────────────────────────────────
      // One slot per lane. A chip that spanned the whole panel overlapped its
      // neighbour as soon as a rewind produced a second branch, so with several
      // lanes each gets an equal share of the row and the current one is marked
      // rather than widened.
      const chipSlots = layout.lanes.length
      const chipSlotW = Math.max(120,
        (layout.width - GRAPH_PAD * 2 - Math.max(0, chipSlots - 1) * 10) / Math.max(1, chipSlots))
      for (const [laneIndex, lane] of layout.lanes.entries()) {
        const laneNodes = laneNodesOf(lane)
        if (laneNodes.length === 0) continue
        const isCurrent = lane.sessionId === currentSessionId
        // No visible "current branch" label: the accent dot marks which one is
        // current, and the title gets the whole slot. The badge survives in the
        // accessible name and the tooltip, where it costs nothing.
        const prefix = ''
        const a11yPrefix = isCurrent ? `${t('badge.current')} · ` : ''
        // Slot geometry: equal shares, laid left to right in lane order. A 4% safety
        // margin keeps the ellipsis inside the rounded box (measured text that lands
        // a hair wide is exactly what "gives the seam away").
        const chipX = GRAPH_PAD - 2 + laneIndex * (chipSlotW + 10)
        const chipW = chipSlotW
        const chipRoom = Math.max(60, (chipW - (isCurrent ? 26 : 18)) * 0.96)
        const body = fitText(lane.chip, chipRoom, 11)
        const text = `${prefix}${body}`
        children.push(React.createElement('g', {
          key: `lane-${lane.sessionId}`,
          // Truncated is fine; hiding it is not. Clicking the chip reveals the whole
          // title, so a long branch name is one click away instead of unreachable.
          className: 'rw-chip',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': openChip === lane.sessionId,
          'aria-label': `${a11yPrefix}${lane.chip}`,
          onClick: (event) => {
            event?.stopPropagation?.()
            onToggleChip(openChip === lane.sessionId ? undefined : lane.sessionId)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation?.()
              onToggleChip(openChip === lane.sessionId ? undefined : lane.sessionId)
            }
          },
        }, [
          React.createElement('rect', {
            key: 'bg',
            x: chipX,
            y: 8,
            width: chipW,
            height: 22,
            rx: 11,
            fill: 'var(--rw-bg-3)',
            stroke: openChip === lane.sessionId ? 'var(--rw-line-strong)' : 'var(--rw-line)',
            strokeWidth: 1,
          }),
          isCurrent
            ? React.createElement('circle', {
              key: 'dot',
              cx: chipX + 11,
              cy: 19,
              r: 3,
              fill: 'var(--rw-accent)',
            })
            : null,
          React.createElement('text', {
            key: 'label',
            x: chipX + (isCurrent ? 19 : 9),
            y: 23,
            fill: isCurrent ? 'var(--rw-fg)' : 'var(--rw-fg-3)',
            fontSize: 11,
            fontFamily: 'inherit',
          }, text),
          React.createElement('title', { key: 'tip' }, `${a11yPrefix}${lane.chip}`),
        ].filter(Boolean)))
        // The revealed title: wrapped lines in a card laid over the timeline, so it
        // can be any length without ever spilling out of the chip.
        if (openChip === lane.sessionId) {
          const full = `${a11yPrefix}${lane.chip}`
          const lines = wrapText(full, chipRoom, 11, 8)
          const lineH = 15
          const boxH = 14 + lines.length * lineH
          children.push(React.createElement('g', {
            key: `lane-full-${lane.sessionId}`,
            className: 'rw-chippop',
            role: 'button',
            tabIndex: 0,
            'aria-label': full,
            onClick: (event) => {
              event?.stopPropagation?.()
              onToggleChip(undefined)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation?.()
                onToggleChip(undefined)
              }
            },
          }, [
            React.createElement('rect', {
              key: 'bg',
              x: chipX,
              y: 6,
              width: chipW,
              height: boxH,
              rx: 10,
              fill: 'var(--rw-bg)',
              stroke: 'var(--rw-line-strong)',
              strokeWidth: 1,
            }),
            ...lines.map((line, index) => React.createElement('text', {
              key: `line-${index}`,
              x: chipX + (isCurrent ? 19 : 9),
              y: 6 + 18 + index * lineH,
              fill: isCurrent ? 'var(--rw-fg)' : 'var(--rw-fg-3)',
              fontSize: 11,
              fontFamily: 'inherit',
            }, line)),
          ]))
        }
      }

      // ── rows ──────────────────────────────────────────────────────────────
      for (const node of layout.nodes) {
        const checkpoint = node.checkpoint
        const selected = checkpoint.id === selectedId
        // A row inside an abandoned run is dead wood even when its own next turn
        // became live again (the new turn after an edit-and-re-ask).
        const onActiveBranch = node.dead !== true && checkpoint.abandoned !== true
        const isSafety = checkpoint.kind === 'safety'
        // A block header: one line standing in for ten rows, with its +/− control
        // at the right edge of the line.
        const isGroup = node.group === true
        // A folded block is drawn as one summary row while staying a REAL checkpoint:
        // it is the block's first row, so its details and rewind actions work and no
        // separate control is needed. `folded` only changes how the row reads.
        const folded = checkpoint.folded
        const isFolded = folded !== undefined
        const stripe = isGroup ? 'var(--rw-line-strong)' : kindColor(checkpoint)
        const state = isGroup ? '' : nodeState(checkpoint, t)
        // The right column carries the facts: what the snapshot holds, then what the
        // turn cost — tokens in → out, tool calls, duration — right of the KB figure.
        const info = isGroup ? '' : [snapshotInfo(checkpoint, t), usageSummary(checkpoint, t)]
          .filter((part) => part !== '').join(' · ')
        const title = isGroup || isFolded
          ? t('panel.groupRow', {
            count: (isFolded ? folded.count : checkpoint.count) ?? 0,
            // Plain numbers: the copy already says "turn", so pre-labelled values
            // would read "第 轮次 1 – 轮次 9 轮".
            from: String((isFolded ? folded.from : checkpoint.from) ?? ''),
            to: String((isFolded ? folded.to : checkpoint.to) ?? ''),
          })
          : isSafety ? t('kind.safety') : turnLabel(checkpoint.afterTurn, t)
        // The prompt, then the same usage summary the right column carries: the row
        // states what the turn was and what it cost, inside the box. They are drawn
        // as two runs — the prompt flexes, the numbers are a fixed-width suffix — so
        // a long prompt can never push the numbers off the row.
        // Inline: the token counts. The right column carries the whole summary, so the
        // prompt line stays short enough to be readable on a narrow card.
        // The counts appear ONCE, in the right column next to the file figure: showing
        // them on the prompt line as well read as a duplicate (and cost prompt room).
        const usageText = ''
        const promptPart = isGroup || isFolded
          // A folded block says so instead of repeating its first prompt.
          ? t('panel.groupCollapsed')
          : (checkpoint.prompt !== undefined && checkpoint.prompt !== ''
            ? checkpoint.prompt
            : (checkpoint.label ?? ''))
        const subtitle = [promptPart, usageText].filter((part) => part !== '').join('  ·  ')
        // The right column is measured first, so the text columns can never run into
        // it — SVG text does not clip or wrap. It gets whatever the card has beyond a
        // readable floor for the title and prompt, so the figures are not cut off on a
        // long row; only a genuinely narrow card ellipsises them.
        const rightCap = Math.max(90, node.w - MIN_TEXT_ROOM)
        const rightW = Math.min(rightCap, Math.max(measureText(state, 11), measureText(info, 11),
          (isGroup || isFolded) && typeof onToggleGroup === 'function' ? 30 : 0))
        const stateText = fitText(state, rightW, 11)
        const infoText = fitText(info, rightW, 11)
        const textPad = CARD_PAD
        const textRoom = node.w - textPad - 18 - (rightW === 0 ? 0 : rightW + 16)
        const text1 = fitText(title, textRoom, 12)
        // The usage is a fixed-width SUFFIX on the prompt line: the prompt flexes and
        // is ellipsised, the numbers always stay. That is the difference between a
        // long prompt merely shortening itself and pushing the numbers off the row.
        const usageW = usageText === '' ? 0 : measureText(usageText, 11) + 14
        const text2 = fitText(promptPart, Math.max(40, textRoom - usageW), 11)
        const usageX = node.x + textPad + measureText(text2, 11) + (usageText === '' ? 0 : 14)
        children.push(React.createElement('g', {
          key: checkpoint.id,
          className: 'rw-node',
          // A block header is a fold control, not a checkpoint: clicking it folds
          // or unfolds its ten rows and never opens the details pane, which has
          // nothing to say about a block.
          onClick: (event) => {
            // Selecting must not bubble to the canvas, which clears the
            // selection (clicking empty space dismisses the details).
            event?.stopPropagation?.()
            if (isGroup && checkpoint.folded === undefined) {
              if (typeof onToggleGroup === 'function') onToggleGroup(checkpoint.from)
              return
            }
            onSelect(checkpoint.id)
          },
          role: 'button',
          tabIndex: 0,
          'aria-label': `${title} ${subtitle}`.trim(),
          'aria-pressed': isGroup
            ? (checkpoint.collapsed === true ? 'false' : 'true')
            : (selected ? 'true' : 'false'),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (isGroup) {
                if (typeof onToggleGroup === 'function') onToggleGroup(checkpoint.from)
                return
              }
              onSelect(checkpoint.id)
            }
          },
        }, [
          React.createElement('line', {
            key: 'stub',
            className: 'rw-stub',
            x1: node.railX,
            y1: dotY(node),
            x2: node.x,
            y2: dotY(node),
            stroke: 'var(--rw-line-strong)',
            strokeWidth: 1,
            opacity: onActiveBranch ? 0.9 : 0.5,
            strokeDasharray: onActiveBranch ? undefined : '3 3',
          }),
          React.createElement('circle', {
            key: 'dot-out',
            className: 'rw-dot',
            cx: node.railX,
            cy: dotY(node),
            r: 5,
            fill: 'var(--rw-bg-2)',
            stroke: stripe,
            strokeWidth: 2,
          }),
          React.createElement('circle', {
            key: 'dot',
            className: 'rw-dot',
            cx: node.railX,
            cy: dotY(node),
            r: 1.6,
            fill: stripe,
          }),
          React.createElement('rect', {
            key: 'box',
            className: 'rw-card',
            x: node.x,
            y: node.y,
            width: node.w,
            height: node.h,
            rx: 10,
            fill: onActiveBranch ? NODE_FILL : 'var(--rw-bg-2)',
            stroke: 'var(--rw-line)',
            strokeWidth: 1,
            strokeDasharray: isGroup === true ? '4 4' : (onActiveBranch ? undefined : '5 3'),
          }),
          React.createElement('rect', {
            key: 'stripe',
            className: 'rw-stripe',
            x: node.x + 1,
            y: node.y + 11,
            width: 3,
            height: node.h - 22,
            rx: 2,
            fill: stripe,
            opacity: onActiveBranch ? 1 : 0.6,
          }),
          selected
            ? React.createElement('rect', {
              key: 'selected',
              className: 'rw-selected',
              x: node.x,
              y: node.y,
              width: node.w,
              height: node.h,
              rx: 10,
              fill: 'var(--rw-accent)',
              fillOpacity: 0.14,
              stroke: 'var(--rw-accent)',
              strokeWidth: 1.5,
            })
            : null,
          React.createElement('text', {
            key: 'title',
            x: node.x + textPad,
            y: node.y + 20,
            fill: onActiveBranch ? 'var(--rw-fg)' : 'var(--rw-fg-3)',
            fontSize: 12,
            fontWeight: '600',
            fontFamily: 'inherit',
          }, text1),
          React.createElement('text', {
            key: 'subtitle',
            x: node.x + textPad,
            y: node.y + 35,
            fill: 'var(--rw-fg-3)',
            fontSize: 11,
            fontFamily: 'inherit',
          }, text2),
          // The turn's numbers, right after the prompt and never truncated away.
          usageText === ''
            ? null
            : React.createElement('text', {
              key: 'usage',
              className: 'rw-usage',
              x: usageX,
              y: node.y + 35,
              fill: 'var(--rw-fg-3)',
              fontSize: 11,
              fontFamily: 'inherit',
            }, usageText),
          state === ''
            ? null
            : React.createElement('text', {
              key: 'state',
              x: node.x + node.w - CARD_PAD,
              y: node.y + 20,
              textAnchor: 'end',
              fill: checkpoint.alreadyRewound === true || checkpoint.replacedByOther === true
                ? 'var(--rw-fg-3)'
                : 'var(--rw-warn)',
              fontSize: 11,
              fontFamily: 'inherit',
            }, stateText),
          info === ''
            ? null
            : React.createElement('text', {
              key: 'info',
              x: node.x + node.w - CARD_PAD,
              y: node.y + 35,
              textAnchor: 'end',
              fill: 'var(--rw-fg-3)',
              fontSize: 11,
              fontFamily: 'inherit',
            }, infoText),
          // …and, left of it, a one-click way to act on the block's own last
          // checkpoint: folding hides rows, never the ability to roll back to them.
          // The +/− control belongs to a fold: on the summary of a collapsed block,
          // and on the first row of an expanded one (whose rows are ordinary). It is
          // drawn in the right-hand time gutter, not on the card.
          (isGroup || checkpoint.control !== undefined) && typeof onToggleGroup === 'function'
            ? groupButton(node, isGroup ? true : checkpoint.control?.collapsed === true)
            : null,
        ].filter(Boolean)))
      }

      return React.createElement('svg', {
        width: layout.width,
        height: layout.height,
        role: 'img',
        'aria-label': t('panel.title'),
        style: { display: 'block' },
        // Clicking empty canvas clears the selection, which hides the details.
        onClick: () => onSelect(undefined),
      }, children)
    }

    // ───────────────────────────────────────────────────────────────────────
    // details pane
    // ───────────────────────────────────────────────────────────────────────
    /** Right-hand pane: facts about the selected checkpoint and its actions. */
    function DetailsPane(props) {
      const { checkpoint, session, workspace, t, onAction, busy, plan, onClose, canReask, reaskNote, inplace, inplaceReason, restoreFiles } = props
      // The prompt is editable so a turn can be re-asked with better wording;
      // the draft follows the selection.
      const [draft, setDraft] = React.useState(checkpoint?.prompt ?? '')
      React.useEffect(() => {
        setDraft(checkpoint?.prompt ?? '')
      }, [checkpoint?.id, checkpoint?.prompt])
      if (checkpoint === undefined || checkpoint === null) {
        return React.createElement('div', { className: 'rw-empty' }, t('detail.none'))
      }
      const rows = [
        [t('detail.turn'), turnLabel(checkpoint.afterTurn, t)],
        [t('detail.time'), formatTime(checkpoint.createdAt)],
        [t('detail.kind'), t(`kind.${checkpoint.kind ?? 'auto'}`)],
        [t('detail.branch'), `${session?.id ?? checkpoint.sessionId}${session?.parentSession === undefined ? '' : t('panel.inherited')}`],
      ]
      if (checkpoint.forkAtSeq !== undefined) rows.push([t('detail.forkAt'), `seq ${checkpoint.forkAtSeq}`])
      if (checkpoint.stats !== undefined) {
        rows.push([t('detail.stats'), `${checkpoint.stats.files} ${t('summary.files')} · ${formatBytes(checkpoint.stats.bytes)}`])
      }
      if (checkpoint.droppedTurns > 0) {
        rows.push([t('detail.dropped'), `${checkpoint.droppedTurns} ${t('detail.droppedTurns')}`])
      }
      // The turn's own cost, broken down. This is the table the card only summarises.
      if (checkpoint.usage !== undefined) {
        const usage = checkpoint.usage
        rows.push([t('usage.title'), `↑ ${usage.inputTokens ?? 0} · ↓ ${usage.outputTokens ?? 0}`])
        if ((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0) {
          rows.push([t('usage.cacheRead'), `${usage.cacheReadTokens ?? 0} / ${usage.cacheWriteTokens ?? 0}`])
        }
        rows.push([t('usage.total'), String(usage.totalTokens ?? 0)])
      }
      if (typeof checkpoint.steps === 'number' && checkpoint.steps > 0) {
        rows.push([t('usage.steps'), String(checkpoint.steps)])
      }
      if (typeof checkpoint.toolCalls === 'number' && checkpoint.toolCalls > 0) {
        rows.push([t('usage.toolCalls'), String(checkpoint.toolCalls)])
      }
      const turnDuration = formatDuration(checkpoint.durationMs)
      if (turnDuration !== '') rows.push([t('usage.duration'), turnDuration])
      if (typeof checkpoint.model === 'string' && checkpoint.model !== '') {
        rows.push([t('usage.model'), checkpoint.model])
      }
      const files = plan?.workspace?.summary
      const children = [
        React.createElement('div', { key: 'title', className: 'rw-side-head' }, [
          React.createElement('span', { key: 't', className: 'rw-title' }, t('detail.title')),
          React.createElement('div', { key: 'spacer', className: 'rw-spacer' }),
          typeof onClose === 'function'
            ? React.createElement('button', {
              key: 'close',
              className: 'rw-btn',
              'data-variant': 'quiet',
              type: 'button',
              onClick: onClose,
              title: t('detail.close'),
              'aria-label': t('detail.close'),
            }, React.createElement(Glyph, { key: 'g', kind: 'close' }))
            : null,
        ].filter(Boolean)),
      ]
      for (const [key, value] of rows) {
        children.push(React.createElement('div', { key: `row-${key}`, className: 'rw-row' }, [
          React.createElement('span', { key: 'k', className: 'rw-k' }, key),
          React.createElement('span', { key: 'v', className: 'rw-v' }, String(value)),
        ]))
      }
      if (checkpoint.prompt !== undefined && checkpoint.prompt !== '') {
        const dirty = draft !== (checkpoint.prompt ?? '')
        children.push(React.createElement('div', { key: 'prompt', style: { marginTop: 10 } }, [
          React.createElement('div', { key: 'h', className: 'rw-k', style: { marginBottom: 4 } }, t('detail.prompt')),
          React.createElement('textarea', {
            key: 'b',
            className: 'rw-prompt',
            value: draft,
            spellCheck: false,
            rows: 4,
            'aria-label': t('detail.prompt'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { event.stopPropagation() },
          }),
          React.createElement('div', { key: 'hint', className: 'rw-hint' }, t('detail.promptHint')),
          // Reward to just before this turn and ask again with the edited text.
          // The control is compact (it hugs its label) so it reads as a button
          // rather than a gold bar across the pane; the full explanation lives in
          // the title and the line underneath.
          React.createElement('div', { key: 'reask', className: 'rw-reask' }, [
            React.createElement('button', {
              key: 'b',
              className: 'rw-btn rw-reask-btn',
              'data-variant': 'gold',
              'data-dirty': dirty ? 'true' : undefined,
              type: 'button',
              disabled: busy || !canReask,
              onClick: () => onAction('reask', { text: draft }),
              title: canReask
                ? (inplace ? t('notice.reaskExplain') : t('notice.agentExplain'))
                : (reaskNote ?? conversationNote(checkpoint, t)),
            }, [
              React.createElement(Glyph, { key: 'g', kind: 'refresh', size: 12 }),
              React.createElement('span', { key: 'l' }, inplace
                ? (restoreFiles ? t('action.reaskCode') : t('action.reask'))
                : (restoreFiles ? t('notice.reaskCodeViaAgent') : t('notice.reaskViaAgent'))),
              dirty
                ? React.createElement('span', { key: 'd', className: 'rw-edit-dot', title: t('detail.promptEdited'), 'aria-label': t('detail.promptEdited') })
                : null,
            ].filter(Boolean)),
            canReask
              ? null
              : React.createElement('span', { key: 'n', className: 'rw-hint' }, conversationNote(checkpoint, t)),
          ].filter(Boolean)),
          canReask
            ? React.createElement('div', { key: 'reask-note', className: 'rw-hint' }, t('notice.reaskShort'))
            : null,
        ]))
      }
      if (files !== undefined) {
        children.push(React.createElement('div', { key: 'files', style: { marginTop: 10 } }, [
          React.createElement('div', { key: 'h', className: 'rw-k', style: { marginBottom: 4 } }, t('action.workspace')),
          React.createElement('div', { key: 's', className: 'rw-v' },
            `${t('summary.restored')} ${files.restored} · ${t('summary.recreated')} ${files.recreated} · ${t('summary.deleted')} ${files.deleted}`),
          React.createElement('ul', { key: 'l', className: 'rw-list' }, [
            ...(files.plan?.added ?? []).slice(0, 6).map((rel) => React.createElement('li', { key: `a-${rel}`, className: 'rw-mono' }, `+ ${rel}`)),
            ...(files.plan?.changed ?? []).slice(0, 6).map((rel) => React.createElement('li', { key: `c-${rel}`, className: 'rw-mono' }, `~ ${rel}`)),
            ...(files.plan?.removed ?? []).slice(0, 6).map((rel) => React.createElement('li', { key: `r-${rel}`, className: 'rw-mono' }, `- ${rel}`)),
          ]),
        ]))
      }
      // Which directories a rollback to this checkpoint would cover.
      const roots = plan?.workspace?.roots ?? checkpoint.roots
      if (Array.isArray(roots) && roots.length > 0) {
        children.push(React.createElement('div', { key: 'roots', style: { marginTop: 10 } }, [
          React.createElement('div', { key: 'h', className: 'rw-k', style: { marginBottom: 4 } }, t('panel.roots')),
          React.createElement('ul', { key: 'l', className: 'rw-list' },
            roots.map((entry) => React.createElement('li', { key: entry.root ?? entry, className: 'rw-mono' },
              entry.summary === undefined
                ? String(entry.root ?? entry)
                : `${entry.root} · ${entry.summary.restored}/${entry.summary.recreated}/${entry.summary.deleted}`))),
        ]))
      }
      children.push(React.createElement('div', { key: 'actions', className: 'rw-actions' },
        ...actionButtons({ checkpoint, t, onAction, busy, inplace, inplaceReason })))
      void workspace
      void session
      return React.createElement('div', null, ...children)
    }

    /** Why a conversation action is unavailable, if it is. */
    const conversationNote = (checkpoint, t) => {
      // Every one of these rows is off the model-visible surface, so an in-place
      // rewind has nothing to cut at — but the events are still in the log, which
      // is exactly what a branch is for. Say that, instead of leaving a dead
      // button with no way forward.
      const branchHint = checkpoint.canFork === true ? ` ${t('notice.branchHint')}` : ''
      if (checkpoint.alreadyRewound === true) return t('notice.unreachable') + branchHint
      if (checkpoint.compacted === true) return t('notice.compacted') + branchHint
      if (checkpoint.promptReplaced === true) return t('notice.promptReplaced') + branchHint
      if (checkpoint.replacedByOther === true) return t('notice.replacedByOther') + branchHint
      if (checkpoint.hasNextTurn === false) {
        return checkpoint.nextTurnExists === true ? t('notice.noPromptTurn') : t('notice.noNextTurn')
      }
      return t('notice.noFork')
    }

    /**
     * The checkpoint to rewind to when re-asking one turn, or undefined.
     *
     * "Edit and re-ask" on row k means: undo turn k and ask the edited version
     * instead. A rewind cuts at the NEXT turn's user message, so undoing turn k
     * means applying the checkpoint that sits just before it — the row above it.
     * That row must itself be rewritable (`reachable`), which is precisely the
     * statement that turn k is still on the model-visible surface.
     *
     * Gating on this row's own `canFork` instead would silently disable the
     * action on the newest turn, which is where it is wanted most.
     */
    function reaskAnchorFor(checkpoints, selected) {
      if (selected === undefined || selected === null) return undefined
      if (selected.prompt === undefined || selected.prompt === '') return undefined
      const previous = checkpoints
        .filter((checkpoint) => checkpoint.sessionId === selected.sessionId
          && checkpoint.kind !== 'safety'
          && typeof checkpoint.afterTurn === 'number'
          && checkpoint.afterTurn < selected.afterTurn)
        .sort((a, b) => b.afterTurn - a.afterTurn)[0]
      // The row above must be a place the rewind can cut at. A row whose prompt the
      // shell or another producer replaced still qualifies: the events are in the
      // log, and this plugin shadows them with its own replacement — which is what
      // makes "rewind this question and ask it again" work on a replaced turn.
      const cuttable = previous !== undefined
        && (previous.reachable === true
          || previous.replacedByOther === true
          || previous.promptReplaced === true)
      if (!cuttable) return undefined
      return previous
    }

    /** The action buttons valid for one checkpoint. */
    function actionButtons(props) {
      const { checkpoint, t, onAction, busy, inplace, inplaceReason } = props
      const buttons = []
      if (checkpoint.kind === 'safety') {
        buttons.push(React.createElement('button', {
          key: 'restoreSafetyWorkspace',
          className: 'rw-btn',
          'data-variant': 'primary',
          disabled: busy || checkpoint.canRestoreWorkspace !== true,
          type: 'button',
          onClick: () => onAction('restoreSafetyWorkspace'),
        }, t('action.restoreSafety')))
        return buttons
      }
      const push = (id, label, variant, enabled, note) => {
        buttons.push(React.createElement('div', { key: id }, [
          React.createElement('button', {
            key: 'b',
            className: 'rw-btn',
            'data-variant': variant,
            disabled: busy || enabled !== true,
            onClick: () => onAction(id),
            type: 'button',
          }, label),
          note !== undefined && enabled !== true
            ? React.createElement('div', { key: 'n', className: 'rw-hint' }, note)
            : null,
        ]))
      }
      // A row is rewritable when the model-visible history still has a cut there. A
      // row whose prompt the shell (or another producer) replaced is NOT excluded:
      // the replacement lives in the log, this plugin can shadow it with its own, and
      // "rewind the question and ask again" is exactly what was asked for. The host
      // still validates the write, so a refusal arrives as a message rather than as a
      // permanently dead button.
      const rewritable = checkpoint.reachable === true
        || checkpoint.replacedByOther === true
        || checkpoint.promptReplaced === true
      push('conversationFork', t('action.fork'), 'primary', checkpoint.canFork === true, conversationNote(checkpoint, t))
      push('workspace', t('action.workspace'), 'default', checkpoint.canRestoreWorkspace === true, t('notice.noManifest'))
      push('bothFork', t('action.both'), 'default',
        checkpoint.canFork === true && checkpoint.canRestoreWorkspace === true)
      // In-place forgetting writes a surface replacement into this conversation's
      // own log, which some session formats cannot be reloaded from — the host
      // refuses it, so the control says so instead of failing silently.
      push('conversationInplace', inplace
        ? (checkpoint.canRestoreWorkspace === true && rewritable ? t('action.inplaceCode') : t('action.inplace'))
        : (checkpoint.canRestoreWorkspace === true ? t('notice.inplaceCodeViaAgent') : t('notice.inplaceViaAgent')), 'default',
        rewritable, inplace ? conversationNote(checkpoint, t) : inplaceReason)
      push('bothInplace', inplace ? t('action.bothInplace') : t('notice.bothViaAgent'), 'default',
        rewritable && checkpoint.canRestoreWorkspace === true, inplaceReason)
      return buttons
    }

    // ───────────────────────────────────────────────────────────────────────
    // confirmation dialog
    // ───────────────────────────────────────────────────────────────────────
    /** Modal that states exactly what a rollback will change before it runs. */
    function ConfirmDialog(props) {
      const { request, plan, t, onCancel, onConfirm, busy, error, queued } = props
      const lines = []
      if (request.conversation === 'inplace') {
        lines.push(t('notice.inplaceExplain'))
        lines.push(t('notice.abandonedWarn'))
      }
      if (request.reask === true) {
        lines.push(t('notice.reaskConfirm'))
        if (typeof request.text === 'string' && request.text !== '') lines.push(request.text.slice(0, 220))
      }
      if (request.conversation === 'fork') lines.push(t('notice.forkExplain'))
      if (request.workspace === 'restore') {
        lines.push(t('notice.workspaceExplain'))
        lines.push(t('notice.safety'))
      }
      if (plan?.conversation?.ok === true && plan.conversation.droppedTurns !== undefined) {
        lines.push(`${t('detail.dropped')} ${plan.conversation.droppedTurns.length} ${t('detail.droppedTurns')}`)
      }
      if (plan?.workspace?.ok === true && plan.workspace.summary !== undefined) {
        const summary = plan.workspace.summary
        lines.push(`${t('summary.restored')} ${summary.restored} · ${t('summary.recreated')} ${summary.recreated} · ${t('summary.deleted')} ${summary.deleted}`)
      }
      return React.createElement('div', { className: 'rw-modal-wrap' }, [
        React.createElement('div', { key: 'backdrop', className: 'rw-backdrop', onClick: busy ? undefined : onCancel }),
        React.createElement('div', {
          key: 'dialog',
          className: 'rw-modal',
          role: 'dialog',
          'aria-modal': 'true',
          // Whatever the layer order, a click on the dialog belongs to the dialog:
          // it must never reach the backdrop, which cancels.
          onClick: (event) => event?.stopPropagation?.(),
        }, [
          React.createElement('h4', { key: 'h' }, t('notice.confirmTitle')),
          React.createElement('ul', { key: 'l' }, lines.map((line, index) => React.createElement('li', { key: index }, line))),
          // A failure is reported here, where the click happened, instead of only
          // in the banner at the top of the panel where it is easy to miss.
          error === undefined
            ? null
            : React.createElement('div', { key: 'e', className: 'rw-banner', 'data-kind': 'error' }, error),
          queued === true
            ? React.createElement('div', { key: 'q', className: 'rw-banner', 'data-kind': 'ok' }, t('notice.queued'))
            : null,
          React.createElement('div', { key: 'a', className: 'rw-modal-actions' }, [
            React.createElement('button', { key: 'c', className: 'rw-btn', type: 'button', disabled: busy, onClick: onCancel }, t('action.cancel')),
            // While the action is running the button reports it; while it is
            // queued it becomes a plain acknowledgement, so the dialog never
            // presents a dead grey button with no way forward.
            queued === true
              ? React.createElement('button', {
                key: 'ok',
                className: 'rw-btn',
                'data-variant': 'primary',
                type: 'button',
                onClick: onCancel,
              }, t('action.gotIt'))
              : React.createElement('button', {
                key: 'o',
                className: 'rw-btn',
                'data-variant': 'primary',
                type: 'button',
                disabled: busy,
                onClick: onConfirm,
                'data-busy': busy ? 'true' : undefined,
              }, busy
                ? [React.createElement('span', { key: 's', className: 'rw-spin' }), t('action.running')]
                : error === undefined ? t('action.confirm') : t('action.retry')),
          ]),
        ]),
      ])
    }

    const legendItem = (label, color) => React.createElement('span', { key: label }, [
      React.createElement('i', { key: 'i', style: { background: color } }),
      label,
    ])

    // ───────────────────────────────────────────────────────────────────────
    // the workspace panel (shared by the overlay and the settings page)
    // ───────────────────────────────────────────────────────────────────────
    /** Full panel: header, tree, details, confirmation, status. */
    function RewindPanel(props) {
      const { ctx, variant = 'inline', onClose } = props
      const active = useActiveSession(ctx)
      const { sessionId, sessions } = active
      const overlayOpen = useOverlayOpen()
      const visible = variant !== 'overlay' || overlayOpen
      const overview = useOverview(sessionId, { active: visible })

      // Escape closes the drawer from anywhere. A window-level listener is used
      // rather than a keydown on the drawer because the drawer may never take
      // focus — the OS title-bar strip can swallow clicks in its top rows.
      React.useEffect(() => {
        if (variant !== 'overlay' || !overlayOpen) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOverlay(false)
        }
        globalThis.addEventListener?.('keydown', onKey)
        return () => globalThis.removeEventListener?.('keydown', onKey)
      }, [variant, overlayOpen])
      const [selectedId, setSelectedId] = React.useState(undefined)
      const [plan, setPlan] = React.useState(undefined)
      const [request, setRequest] = React.useState(undefined)
      const [runError, setRunError] = React.useState(undefined)
      const [queued, setQueued] = React.useState(false)
      // The last confirmed action and its outcome, kept on screen: a screenshot then
      // says exactly which call was issued and what the host answered.
      const [lastResult, setLastResult] = React.useState(undefined)
      // Which blocks the user has opened, keyed by the block's first turn so the
      // state survives new checkpoints arriving. Empty = every full block folded.
      const [expandedGroups, setExpandedGroups] = React.useState(() => new Set())
      // The branch chip whose full title is revealed (clicking the chip toggles it).
      const [openChip, setOpenChip] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(undefined)
      // A banner is a passing remark: it clears itself (sooner when it is good news).
      React.useEffect(() => {
        if (notice === undefined) return undefined
        const handle = setTimeout(() => setNotice(undefined), notice.kind === 'error' ? 9000 : 4000)
        return () => clearTimeout(handle)
      }, [notice])

      const data = overview.data
      const allCheckpoints = data?.checkpoints ?? []
      const sessionsList = data?.sessions ?? []
      // Row cards fill the graph viewport, so its width is an input to layout.
      const graphRef = React.useRef(null)
      // Opening the panel is a layout change worth re-measuring for.
      const graphWidth = useMeasuredWidth(graphRef, DEFAULT_GRAPH_W, visible ? 1 : 0)
      // One memo for the whole fold -> layout result, keyed on the values it is
      // built from. Keying it on the fetched payload alone kept returning the
      // previous graph, which is why the +/− control looked dead: the state
      // flipped while the picture stayed the same.
      const { visible: checkpoints, layout } = React.useMemo(
        () => graphFor(sessionsList, allCheckpoints, {
          expandedGroups,
          limit: COLLAPSE_LIMIT,
          width: graphWidth,
        }),
        [allCheckpoints, sessionsList, expandedGroups, graphWidth],
      )
      // When the shell cannot name its session, the host auto-picks one and
      // reports it back; the panel then works against that id.
      const effectiveSessionId = sessionId ?? data?.currentSessionId
      const cwd = active.cwd ?? data?.cwd
      const selected = selectedCheckpointOf(checkpoints, selectedId)
      const selectedKey = selected === undefined ? '' : `${selected.id}:${selected.manifest}:${selected.createdAt}`
      // Re-asking one turn rewinds to the checkpoint just before it, so the anchor
      // (and whether this turn is still on the surface) decides the gold button.
      const reaskAnchor = reaskAnchorFor(checkpoints, selected)
      // Whether an edited re-ask also puts the workspace files back. That is what
      // makes the rollback worth doing: the new prompt is then answered against the
      // tree as it was, not against the code the abandoned turn left behind.
      const restoreFiles = selected?.canRestoreWorkspace === true
      // An in-place rewrite is refused by the host in this release (the session log
      // could not be reopened). Say so before the click, not after it fails.
      const inplace = data?.capabilities?.inplaceRewind !== false
      const inplaceReason = data?.capabilities?.inplaceReason

      // A selection is NOT made for the user: the timeline is shown on its own
      // until a checkpoint is picked, and a selection that stops existing (a
      // checkpoint removed by GC, a different conversation) is dropped.
      React.useEffect(() => {
        if (selectedId === undefined) return
        if (selectedCheckpointOf(checkpoints, selectedId) !== undefined) return
        setSelectedId(undefined)
      }, [data, selectedId])

      // Switching workspace or session window switches the conversation under the
      // panel: drop everything that belonged to the previous one so the tree, the
      // details and any pending confirmation always describe what is on screen.
      React.useEffect(() => {
        setSelectedId(undefined)
        setPlan(undefined)
        setRequest(undefined)
        setNotice(undefined)
      }, [effectiveSessionId])

      // Dry-run the selected checkpoint so the pane can show real numbers.
      React.useEffect(() => {
        if (selectedKey === '') {
          setPlan(undefined)
          return undefined
        }
        let cancelled = false
        setPlan(undefined)
        const checkpointId = selectedKey.split(':')[0]
        void (async () => {
          const response = await rpc('plan', {
            checkpointId,
            conversation: 'inplace',
            workspace: 'restore',
          })
          if (!cancelled && response.ok) setPlan(response.value)
        })()
        return () => { cancelled = true }
      }, [selectedKey])

      // Every reload carries the width the graph actually measured, so the host's call
      // log can show whether the panel was drawing into a stale (too small) canvas.
      // The ref exists so a resize never re-creates the reload callback.
      const graphWidthRef = React.useRef(DEFAULT_GRAPH_W)
      graphWidthRef.current = graphWidth
      const reloadAll = React.useCallback(() => overview.reload({ graphWidth: graphWidthRef.current }), [overview])

      // A re-ask that was queued while the agent was mid-turn: the rewind runs at
      // the turn boundary, and this watcher then sends the edited prompt.
      const reaskRef = React.useRef(undefined)
      const queueSeen = React.useRef(undefined)
      React.useEffect(() => {
        const queued = data?.queue
        if (queued === undefined) return
        if (queued.pending !== undefined) return
        const last = queued.last
        if (last === undefined || queueSeen.current === last.at) return
        queueSeen.current = last.at
        const waiting = reaskRef.current
        if (last.ok !== true) {
          // Always report a failed held rewind. Reporting it only for a re-ask
          // meant a plain "forget in place" could be dropped in silence, which is
          // indistinguishable from the button doing nothing.
          reaskRef.current = undefined
          setNotice({ kind: 'error', message: `${t('notice.queuedFailed')}: ${last.message ?? ''}` })
          setLastResult({ action: describeRequest({ conversation: last.conversation, workspace: last.workspace }), outcome: 'error', message: last.message, at: last.at })
          return
        }
        if (waiting === undefined || waiting.checkpointId !== last.checkpointId) return
        reaskRef.current = undefined
        const text = waiting.text.trim()
        const actions = inputActionsFor(effectiveSessionId)
        if (text === '' || actions === undefined) {
          setNotice({ kind: 'error', message: text === '' ? t('notice.reaskEmpty') : t('notice.reaskNoComposer') })
          return
        }
        // Same hand-off as the immediate path: a same-tick submit sends the previous
        // draft, which is what made a queued re-ask arrive without its prompt.
        void submitPrompt(actions, text)
        setNotice({ kind: 'ok', message: `${t('notice.queuedDone')} — ${t('action.reask')}` })
      }, [data, effectiveSessionId])

      /**
       * Rolling the code back is the panel's own job: it needs no open turn.
       *
       * Only the conversation rewrite has to be delegated, because its marker must
       * sit inside an open turn/step. Doing the files here is what makes a
       * confirmed rollback change the workspace at once instead of waiting for the
       * agent to get round to it.
       */
      const restoreFilesNow = React.useCallback(async (checkpoint) => {
        const response = await rpc('apply', {
          checkpointId: checkpoint.id,
          conversation: 'none',
          workspace: 'restore',
          confirm: true,
        })
        if (response.ok !== true) {
          setNotice({ kind: 'error', message: response.error.message })
          setLastResult({ action: 'apply(workspace=restore)', outcome: 'error', message: response.error.message, at: Date.now() })
          return false
        }
        if (response.value.queued === true) {
          setNotice({ kind: 'ok', message: t('notice.queued') })
          return false
        }
        const summary = response.value.workspace
        const message = `${t('action.workspace')}: ${t('summary.restored')} ${summary.restored}`
          + ` · ${t('summary.recreated')} ${summary.recreated}`
          + ` · ${t('summary.deleted')} ${summary.deleted}`
        setNotice({ kind: 'ok', message })
        setLastResult({ action: 'apply(workspace=restore)', outcome: 'ok', message, at: Date.now() })
        await reloadAll()
        return true
      }, [reloadAll])

      /**
       * Send the user's own prompt and let the host roll the conversation back.
       *
       * Nothing about the mechanism goes into the conversation: the host holds the
       * rollback and applies it at the first step of the turn this prompt starts,
       * which is the first moment the session format allows that write. The chat
       * therefore shows exactly what the user typed — no "please run the rewind
       * tool" instruction.
       */
      const runViaHost = React.useCallback(async (options) => {
        const response = await rpc('scheduleRewind', {
          sessionId: effectiveSessionId,
          checkpointId: options.checkpointId,
        })
        if (response.ok !== true) {
          setNotice({ kind: 'error', message: response.error.message })
          setLastResult({ action: 'scheduleRewind', outcome: 'error', message: response.error.message, at: Date.now() })
          return false
        }
        const actions = inputActionsFor(effectiveSessionId)
        if (actions === undefined) {
          setNotice({ kind: 'error', message: t('notice.reaskNoComposer') })
          return false
        }
        if (options.prompt === undefined) {
          setNotice({ kind: 'ok', message: t('notice.scheduled') })
          setLastResult({ action: `scheduleRewind(${options.checkpointId})`, outcome: 'queued', at: Date.now() })
          if (variant === 'overlay') setOverlay(false)
          return true
        }
        if (typeof actions.setDraft === 'function') actions.setDraft(options.prompt)
        if (typeof actions.submit === 'function') actions.submit()
        setNotice({ kind: 'ok', message: t('notice.scheduledReask') })
        setLastResult({ action: `scheduleRewind(${options.checkpointId}) + send`, outcome: 'queued', at: Date.now() })
        if (variant === 'overlay') setOverlay(false)
        return true
      }, [effectiveSessionId, variant])

      const takeSnapshot = React.useCallback(async () => {
        if (effectiveSessionId === undefined) return
        setBusy(true)
        const response = await rpc('snapshot', { sessionId: effectiveSessionId })
        setBusy(false)
        if (response.ok) {
          setNotice({ kind: 'ok', message: t('toast.snapshotDone') })
          await reloadAll()
        } else {
          setNotice({ kind: 'error', message: response.error.message })
        }
      }, [effectiveSessionId, reloadAll])

      const collectGarbage = React.useCallback(async () => {
        setBusy(true)
        const response = await rpc('gc', { confirm: true })
        setBusy(false)
        setNotice(response.ok
          ? { kind: 'ok', message: `${t('toast.gcDone')}: ${response.value.removed} / ${response.value.kept}` }
          : { kind: 'error', message: response.error.message })
      }, [])

      /** Call off a rewind that is waiting for the turn to end. */
      const cancelQueued = React.useCallback(async () => {
        const response = await rpc('cancelQueued', effectiveSessionId === undefined ? {} : { sessionId: effectiveSessionId })
        if (!response.ok) {
          setNotice({ kind: 'error', message: response.error.message })
          return
        }
        reaskRef.current = undefined
        setNotice({ kind: 'ok', message: t('toast.cancelled') })
        await reloadAll()
      }, [effectiveSessionId, reloadAll])

      /** Fork through the shipped client API, then switch the stage to the child. */
      const forkBranch = React.useCallback(async (checkpoint) => {
        const service = sessions ?? ctx.get('sessions')
        if (checkpoint.forkAtSeq === undefined || typeof service?.fork !== 'function') {
          return { ok: false, error: { message: t('notice.noFork') } }
        }
        try {
          const childId = await service.fork({
            sessionId: checkpoint.sessionId,
            atSeq: checkpoint.forkAtSeq,
            increaseTitle: true,
          })
          if (typeof service.open === 'function') service.open(childId)
          return { ok: true, childId }
        } catch (error) {
          return { ok: false, error: { message: String(error?.message ?? error) } }
        }
      }, [sessions, ctx])

      const runRequest = React.useCallback(async () => {
        const pending = request
        if (pending === undefined || pending.checkpoint === undefined) {
          setRunError(t('notice.nothingToDo'))
          return
        }
        setBusy(true)
        setRunError(undefined)
        setQueued(false)
        const checkpoint = pending.checkpoint
        try {
          if (pending.workspace === 'restore') setNotice({ kind: 'ok', message: t('toast.applying') })
          const result = await executeRequest(pending, {
            rpc,
            forkBranch,
            t,
            inputActions: inputActionsFor(effectiveSessionId ?? checkpoint.sessionId),
          })
          if (result.queued === true) {
            if (result.reask !== undefined) reaskRef.current = result.reask
            setQueued(true)
            setNotice({ kind: 'ok', message: t('notice.queued') })
            setLastResult({ action: describeRequest(pending), outcome: 'queued', at: Date.now() })
            await reloadAll()
            return
          }
          setNotice({ kind: 'ok', message: `${t('toast.done')} — ${result.messages.join(' · ')}` })
          setLastResult({ action: describeRequest(pending), outcome: 'ok', message: result.messages.join(' · '), at: Date.now() })
          setRequest(undefined)
          await reloadAll()
          // Get out of the way: the rollback has landed, and what the user wants
          // next is the conversation or the files, not this panel.
          if (variant === 'overlay') setOverlay(false)
        } catch (error) {
          // Keep the dialog open: the failure has to stay next to the button that
          // produced it, and the user must be able to simply try again.
          const message = String(error?.message ?? error)
          setRunError(message)
          setNotice({ kind: 'error', message })
          setLastResult({ action: describeRequest(pending), outcome: 'error', message, at: Date.now() })
        } finally {
          setBusy(false)
        }
      }, [request, reloadAll, forkBranch, effectiveSessionId])

      const onAction = React.useCallback((action, payload) => {
        if (selected === undefined) return
        // Every new request starts clean: state left over from the previous one
        // (a failure, a queued rewind, a stuck busy flag) must never pre-disable
        // this dialog's buttons.
        setRunError(undefined)
        setQueued(false)
        setBusy(false)
        if (action === 'reask') {
          // Undo this turn, put the code back where it was, and ask the edited
          // version: the rewind target is the checkpoint just before the turn, i.e.
          // the row above it. Restoring the files is part of the same intent — a
          // rewind that leaves the code behind answers the new prompt against the
          // wrong tree, which is what "roll back, then what?" was about.
          const anchor = reaskAnchorFor(checkpoints, selected)
          if (anchor === undefined) return
          const restoreWorkspace = selected.canRestoreWorkspace === true
          const text = payload?.text ?? selected.prompt ?? ''
          if (!inplace) {
            // Files first (the panel can do that immediately), then the host holds
            // the conversation rollback until the turn this prompt starts. Only the
            // user's own words go into the chat.
            void (async () => {
              if (restoreWorkspace) {
                const restored = await restoreFilesNow(selected)
                if (!restored) return
              }
              await runViaHost({ checkpointId: anchor.id, prompt: text })
            })()
            return
          }
          setRequest({
            conversation: 'inplace',
            workspace: restoreWorkspace ? 'restore' : 'none',
            reask: true,
            reaskFrom: anchor.id,
            reaskTurn: selected.afterTurn,
            text,
            checkpoint: selected,
          })
          return
        }
        const map = {
          conversationFork: { conversation: 'fork', workspace: 'none' },
          conversationInplace: {
            conversation: 'inplace',
            workspace: selected.canRestoreWorkspace === true ? 'restore' : 'none',
          },
          workspace: { conversation: 'none', workspace: 'restore' },
          bothFork: { conversation: 'fork', workspace: 'restore' },
          bothInplace: { conversation: 'inplace', workspace: 'restore' },
          restoreSafetyWorkspace: { conversation: 'none', workspace: 'restore' },
        }
        const shape = map[action]
        if (shape === undefined) return
        if (!inplace && (action === 'conversationInplace' || action === 'bothInplace')) {
          // The same split as the edited re-ask: restoring the files is the panel's
          // own work and happens at once, while the conversation marker is the
          // agent's to write inside its turn.
          const wantsFiles = action === 'bothInplace' || selected.canRestoreWorkspace === true
          void (async () => {
            if (wantsFiles) {
              const restored = await restoreFilesNow(selected)
              if (!restored) return
            }
            await runViaHost({ checkpointId: selected.id })
          })()
          return
        }
        setRequest({ ...shape, checkpoint: selected })
      }, [selected])

      const body = []
      if (effectiveSessionId === undefined) {
        body.push(React.createElement('div', { key: 'nosession', className: 'rw-empty' }, t('state.noSession')))
      } else if (overview.loading && data === undefined) {
        body.push(React.createElement('div', { key: 'loading', className: 'rw-empty' }, [
          React.createElement('span', { key: 's', className: 'rw-spin' }),
          React.createElement('span', { key: 'x', style: { marginLeft: 8 } }, t('state.loading')),
        ]))
      } else {
        // The timeline takes the whole panel until a checkpoint is selected; the
        // details column then appears on the right, and clicking empty canvas or
        // its close control takes it away again.
        body.push(React.createElement('div', { key: 'body', className: 'rw-body' }, [
          React.createElement('div', { key: 'graph', className: 'rw-graph' }, [
            React.createElement('div', { key: 'legend', className: 'rw-legend' }, [
              legendItem(t('panel.legend.snapshot'), 'var(--rw-ok)'),
              legendItem(t('panel.legend.conversationOnly'), 'var(--rw-accent)'),
              legendItem(t('panel.legend.safety'), 'var(--rw-warn)'),
              legendItem(t('panel.legend.abandoned'), 'var(--rw-fg-3)'),
              // A held rewind says so, and can be called off.
              data?.queue?.pending === undefined
                ? React.createElement('div', { key: 'hint', className: 'rw-legend-hint' }, t('panel.selectHint'))
                : React.createElement('div', { key: 'queued', className: 'rw-legend-queued' }, [
                  React.createElement('span', { key: 'l' }, t('notice.queuedPending')),
                  React.createElement('button', {
                    key: 'c',
                    className: 'rw-btn',
                    'data-variant': 'quiet',
                    type: 'button',
                    onClick: cancelQueued,
                  }, t('action.cancelQueued')),
                ]),
            ]),
            React.createElement('div', {
              key: 'scroll',
              className: 'rw-scroll',
              ref: graphRef,
              onClick: () => setSelectedId(undefined),
            }, React.createElement(TreeGraph, {
              layout,
              selectedId,
              currentSessionId: effectiveSessionId,
              onSelect: setSelectedId,
              openChip,
              onToggleChip: setOpenChip,
              // Each block of ten folds as a whole; its +/− sits at the right edge
              // of that block's header line.
              onToggleGroup: (from) => setExpandedGroups((previous) => {
                const next = new Set(previous)
                if (next.has(from)) next.delete(from)
                else next.add(from)
                return next
              }),
              t,
            })),
          ]),
          selected === undefined
            ? null
            : React.createElement('div', { key: 'side', className: 'rw-side' },
              React.createElement(DetailsPane, {
                checkpoint: selected,
                session: sessionsList.find((session) => session.id === selected?.sessionId),
                workspace: cwd,
                t,
                onAction,
                busy,
                plan,
                // Re-asking needs a rewind target: a next turn that can be cut.
                canReask: reaskAnchor !== undefined,
                restoreFiles,
                reaskNote: inplace ? undefined : inplaceReason,
                inplace,
                inplaceReason,
                onClose: () => setSelectedId(undefined),
              })),
        ].filter(Boolean)))
      }

      const roots = data?.roots ?? []
      // The header carries identity only: every control lives in the footer,
      // which can never sit under the OS title-bar strip.
      const header = React.createElement('div', { className: 'rw-head' }, [
        React.createElement('div', { key: 'title', className: 'rw-title' }, [
          React.createElement(Glyph, { key: 'g', kind: 'branch', size: 15, color: 'var(--rw-accent)' }),
          t('panel.title'),
        ]),
        React.createElement('div', { key: 'sub', className: 'rw-sub', title: roots.length > 0 ? roots.join('\n') : (cwd ?? '') },
          roots.length > 0
            ? `${t('panel.roots')}: ${roots.length === 1 ? roots[0] : t('panel.rootsValue', { count: roots.length })}`
            : (cwd ?? '')),
        data?.build !== undefined && data.build.host !== BUILD_ID
          ? React.createElement('span', { key: 'stale', className: 'rw-badge', 'data-kind': 'warn' }, t('panel.staleHost'))
          : null,
        data?.autoSelected === true
          ? React.createElement('span', { key: 'auto', className: 'rw-badge' }, t('panel.autoSelected'))
          : null,
        React.createElement('div', { key: 'spacer', className: 'rw-spacer' }),
        overview.loading
          ? React.createElement('span', { key: 'spin', className: 'rw-spin' })
          : null,
      ].filter(Boolean))

      const footer = React.createElement('div', { className: 'rw-foot' }, [
        React.createElement('button', {
          key: 'snap',
          className: 'rw-btn',
          type: 'button',
          disabled: busy || effectiveSessionId === undefined,
          onClick: takeSnapshot,
          title: t('action.snapshot'),
        }, [React.createElement(Glyph, { key: 'g', kind: 'plus' }), t('action.snapshot')]),
        React.createElement('button', {
          key: 'refresh',
          className: 'rw-btn',
          type: 'button',
          disabled: busy,
          onClick: () => { void reloadAll() },
          title: t('action.refresh'),
        }, [React.createElement(Glyph, { key: 'g', kind: 'refresh' }), t('action.refresh')]),
        React.createElement('button', {
          key: 'gc',
          className: 'rw-btn',
          type: 'button',
          disabled: busy,
          onClick: collectGarbage,
        }, t('action.gc')),
        React.createElement('div', { key: 'spacer', className: 'rw-spacer' }),
        React.createElement('span', { key: 'cp' }, `${checkpoints.length} ${t('panel.checkpoints')}`),
        React.createElement('span', { key: 'store', title: data?.storeRoot ?? '' }, storeLabel(data?.storeRoot)),
        React.createElement('span', {
          key: 'build',
          className: 'rw-build',
          // Plain concatenation, not a template literal: this line gets edited
          // from shell scripts too, and a mangled backtick breaks the bundle.
          title: 'client ' + BUILD_ID + ' | host ' + String(data?.build?.host ?? '-'),
        }, 'v' + PLUGIN_VERSION + '+' + BUILD_ID),
        lastResult === undefined
          ? null
          : React.createElement('span', {
            key: 'last',
            className: 'rw-last',
            'data-outcome': lastResult.outcome,
            // A failure is reported where the click happened, in the dialog; the
            // footer only names the request. Raw host error text here read as noise
            // (and leaked internal event names) rather than as a status.
            title: describeRequest(request),
          }, describeRequest(request)),
        // Authorship: the GitHub mark links to the project, styled like the other
        // footer controls so it reads as part of the toolbar. The URL is also in
        // the tooltip, because a host that blocks web links still leaves it
        // readable and copyable.
        React.createElement('a', {
          key: 'author',
          className: 'rw-btn rw-author',
          'data-variant': 'quiet',
          href: AUTHOR.repository,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: `${AUTHOR.name} · ${AUTHOR.repository}`,
          'aria-label': `${AUTHOR.name} on GitHub`,
        }, [
          React.createElement(Glyph, { key: 'g', kind: 'github', size: 15 }),
          React.createElement('span', { key: 'n' }, AUTHOR.name),
        ]),
        variant === 'overlay'
          ? React.createElement('button', {
            key: 'close',
            className: 'rw-btn',
            'data-variant': 'quiet',
            type: 'button',
            onClick: onClose,
            title: t('action.close'),
          }, [React.createElement(Glyph, { key: 'g', kind: 'close' }), t('action.close')])
          : null,
      ].filter(Boolean))

      // The banner is a passing remark, not a record: it shows once and then gets
      // out of the way. The durable copy is the dialog's own error (where the click
      // happened) and the footer's action log, so nothing is lost by dismissing it.
      const noticeElement = notice === undefined ? null : React.createElement('div', {
        className: 'rw-banner',
        'data-kind': notice.kind === 'error' ? 'error' : 'ok',
      }, [
        React.createElement('span', { key: 'm', className: 'rw-banner-text' }, notice.message),
        React.createElement('button', {
          key: 'x',
          className: 'rw-banner-x',
          type: 'button',
          'aria-label': t('action.dismiss'),
          title: t('action.dismiss'),
          onClick: () => setNotice(undefined),
        }, '×'),
      ])

      const modal = request === undefined ? null : React.createElement(ConfirmDialog, {
        request,
        plan,
        t,
        busy,
        onCancel: () => setRequest(undefined),
        onConfirm: runRequest,
      })

      if (variant === 'overlay') {
        // The drawer stays mounted while it closes so the exit transition can
        // play; `data-state` drives it and hides it from interaction when shut.
        return React.createElement('div', {
          className: 'rw-root rw-overlay-layer',
          'data-state': visible ? 'open' : 'closed',
          'aria-hidden': visible ? undefined : 'true',
        }, [
          React.createElement('div', {
            key: 'bd',
            className: 'rw-backdrop',
            onClick: () => setOverlay(false),
          }),
          React.createElement('div', {
            key: 'drawer',
            className: 'rw-drawer',
            tabIndex: -1,
            onKeyDown: (event) => { if (event.key === 'Escape') setOverlay(false) },
          }, header, noticeElement, ...body, footer, modal),
        ])
      }
      return React.createElement('div', { className: 'rw-root rw-page' }, header, noticeElement, ...body, footer, modal)
    }

    // ───────────────────────────────────────────────────────────────────────
    // surfaces
    // ───────────────────────────────────────────────────────────────────────
    /** Sidebar footer trigger. */
    function SidebarTrigger(props) {
      const open = useOverlayOpen()
      return React.createElement('button', {
        className: 'rw-root rw-btn',
        'data-variant': open ? 'primary' : 'quiet',
        'data-rewind': 'trigger',
        type: 'button',
        title: t('trigger.title'),
        onClick: toggleOverlay,
      }, [
        React.createElement(Glyph, { key: 'g', kind: 'branch' }),
        props?.wide === false ? null : React.createElement('span', { key: 'l' }, t('trigger.title')),
      ].filter(Boolean))
    }

    /**
     * Invisible session-scoped probe.
     *
     * A session-scoped registration receives the active session id through both
     * `inject(sessionId)` and the `sessionId` prop, plus the composer's public
     * `inputActions`. This renders nothing; it exists so the panel can name the
     * session when the shell's sessions list has not bound yet, and so
     * "rewind and ask again" can place text in the composer and submit it.
     */
    function SessionProbe(props) {
      const sessionId = props?.sessionId
      React.useEffect(() => { noteSlotSession(sessionId) }, [sessionId])
      noteSlotSession(sessionId)
      noteInputActions(sessionId, props?.inputActions)
      return null
    }

    /** Frame-wide drawer. */
    function OverlaySurface(props) {
      return React.createElement(RewindPanel, {
        ctx: props.ctx,
        variant: 'overlay',
        onClose: () => setOverlay(false),
      })
    }

    /** Settings page. */
    function SettingsSurface(props) {
      return React.createElement(RewindPanel, { ctx: props.ctx, variant: 'inline' })
    }

    // ───────────────────────────────────────────────────────────────────────
    // plugin
    // ───────────────────────────────────────────────────────────────────────
    const inject = ['slots']

    /** Mount the plugin: copy, then the surfaces. */
    function apply(ctx) {
      bindTranslator(ctx)
      const locale = ctx.get('locale')
      if (locale !== undefined) {
        ctx.effect(() => locale.register(NS, dictionaries), 'dsh-plugin-rewind: dictionaries')
      }
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // A silent session-scoped seat: it renders nothing and exists only to
      // learn the active session id independently of the sessions list store.
      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'rewind-session-probe',
        order: 900,
        locale: NS,
        inject: (sessionId) => {
          noteSlotSession(sessionId)
          return {}
        },
      }, SessionProbe)), 'dsh-plugin-rewind: session probe')

      // Every contribution is owned by an effect, so unloading the plugin (or a
      // hot reload of this bundle) takes its surfaces with it.
      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'rewind-trigger',
        order: 40,
        locale: NS,
      }, SidebarTrigger)), 'dsh-plugin-rewind: sidebar trigger')

      // The panel uses the declared frame-wide overlay seat, so it never has to
      // reach for `document.body` and never competes with product layout.
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'rewind-panel',
        order: 40,
        locale: NS,
      }, (props) => React.createElement(OverlaySurface, { ...props, ctx }))), 'dsh-plugin-rewind: overlay panel')

      // A first-level settings page keeps the tree reachable even if the
      // sidebar is collapsed or a shell build drops the footer seat.
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'rewind-settings',
        order: 130,
        label: () => localT('settings.title'),
        locale: NS,
      }, (props) => React.createElement(SettingsSurface, { ...props, ctx }))), 'dsh-plugin-rewind: settings page')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'rewind'
    // Exported for the offline test suite: the same components the slots mount.
    exports.RewindPanel = RewindPanel
    exports.TreeGraph = TreeGraph
    exports.DetailsPane = DetailsPane
    exports.ConfirmDialog = ConfirmDialog
    exports.buildLayout = buildLayout
    /** Author metadata, so an offline preview can render the real credit line. */
    exports.author = AUTHOR
    /** Build identity, so the offline preview can show the same badge. */
    exports.buildId = BUILD_ID
    exports.version = PLUGIN_VERSION
    exports.dictionaries = dictionaries
    /** The bundle's own stylesheet, so an offline preview can embed it verbatim. */
    exports.css = CSS
    /**
     * Test-only handles for wiring that markup cannot show: the composer-action
     * capture that "rewind and ask again" depends on.
     */
    exports.__internals = {
      captureInputActions: noteInputActions,
      inputActionsFor,
      reaskAnchorFor,
      groupRows,
      graphFor,
      selectedCheckpointOf,
      overviewSignature,
      executeRequest,
      describeRequest,
      readActiveSession,
      sessionTickSources,
      // Text metrics and the title wrapper, so the chip's reveal can be checked
      // without a browser: a "reveal" that still spills is the original defect.
      measureText,
      wrapText,
      slotSessionIdOf: () => slotSessionId,
    }
    return module.exports
  },
})
