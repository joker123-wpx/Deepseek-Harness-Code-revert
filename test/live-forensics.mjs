/**
 * Live forensics + offline panel preview.
 *
 * Two things this proves without restarting the app:
 *
 *  1. The surface fold and the replacement classifier run correctly against the
 *     REAL stored session log — a long conversation that the harness compacted
 *     must read as `compaction`, not as "you rewound this".
 *  2. The panel's tree renders with real checkpoint data, written out as a
 *     standalone HTML file so a human can look at it in a browser.
 *
 * Run: node test/live-forensics.mjs [sessionId]
 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { analyzeSession, foldSessionSurface } from '../lib/conversation.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh'
const RPC = 'http://127.0.0.1:19387/dsh-rewind/rpc'
const sessionId = process.argv[2] ?? 'session-a6b18617-273b-4998-b309-13c57c19b150'

/** Decode an append-only sequence of zstd frames into its JSONL text. */
function decodeLog(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = buffer.indexOf(MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + 1)
  }
  const parts = []
  let position = 0
  while (position < offsets.length) {
    const start = offsets[position]
    let end = position + 1 < offsets.length ? offsets[position + 1] : buffer.length
    let text
    let consumed = position + 1
    while (true) {
      try {
        text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
        break
      } catch {
        if (consumed >= offsets.length) throw new Error(`frame at ${start} is undecodable`)
        end = consumed + 1 < offsets.length ? offsets[consumed + 1] : buffer.length
        consumed += 1
      }
    }
    parts.push(text)
    position = consumed
  }
  return parts.join('')
}

// ── 1. the real stored log ──────────────────────────────────────────────────
const projectDir = '--C-Users-Administrator-Desktop-new--'
const logPath = join(DSH_HOME, 'sessions', projectDir, sessionId, 'session.v4.jsonl.zstd')
console.log(`log: ${logPath}`)
const raw = await fs.readFile(logPath)
const lines = decodeLog(raw).split('\n').filter((line) => line.trim() !== '')
const records = []
for (const line of lines) {
  try {
    records.push(JSON.parse(line))
  } catch {
    /* ignore a torn final record */
  }
}
const events = records.filter((record) => record.type !== 'session' && typeof record.seq === 'number')
console.log(`events: ${events.length}  frames: ${Math.max(0, records.length - events.length)}`)

const fold = foldSessionSurface(events)
const kindCounts = {}
for (const replacement of fold.replacements) kindCounts[replacement.kind] = (kindCounts[replacement.kind] ?? 0) + 1
console.log(`surface nodes: ${fold.nodes.length}`)
console.log(`replacements: ${fold.replacements.length}`, JSON.stringify(kindCounts))
for (const replacement of fold.replacements.slice(-6)) {
  console.log(`  seq ${replacement.seq} kind=${replacement.kind} shadows ${replacement.shadowed.length} node(s) [${replacement.start}..${replacement.end}]`)
}

// The same analysis the host runs, driven by the stored log through the
// version-tolerant readers.
const fakeSession = {
  header: { id: sessionId, cwd: 'C:\\Users\\Administrator\\Desktop\\new', delegationDepth: 0 },
  snapshotEvents: () => events,
  surface: { nodes: fold.nodes },
  deriveMessages: () => [],
}
const analysis = analyzeSession(fakeSession)
const surfacing = {}
for (const turn of analysis.turns) {
  surfacing[turn.turn] = turn.rewound ? 'rewound' : turn.compacted ? 'compacted' : turn.surfaced ? 'active' : 'shadowed'
}
console.log(`turns: ${analysis.turns.length}  lastTurn=${analysis.lastTurn}`)
console.log(`turn state:`, JSON.stringify(surfacing))
console.log(`rewound seqs: ${analysis.rewoundSeqs.length}  compacted seqs: ${analysis.compactedSeqs.length}`)

// ── 2. the live host payload + a rendered preview ───────────────────────────
async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return response.json()
}

let overview
try {
  const answer = await rpc('overview', { sessionId })
  if (answer.ok !== true) throw new Error(JSON.stringify(answer.error))
  overview = answer.value
  console.log(`live overview: ${overview.checkpoints.length} checkpoint(s) from ${overview.sessions.length} session(s)`)
} catch (error) {
  console.log(`live overview unavailable (${String(error).slice(0, 120)}); using synthetic data`)
  overview = undefined
}

// The payload the running host serves still carries the OLD flag semantics, so
// the preview re-derives the state flags from the stored log where it can.
if (overview !== undefined) {
  for (const checkpoint of overview.checkpoints) {
    const next = analysis.turns.find((turn) => turn.turn === (checkpoint.afterTurn ?? 0) + 1)
    checkpoint.reachable = next === undefined ? false : next.surfaced === true
    checkpoint.alreadyRewound = next?.rewound === true
    checkpoint.compacted = next?.compacted === true
    checkpoint.replacedByOther = next?.replacedByOther === true
    checkpoint.abandoned = next !== undefined && next.surfaced !== true
  }
  console.log(`preview flags: ${overview.checkpoints.map((checkpoint) => checkpoint.alreadyRewound ? 'rewound' : checkpoint.compacted ? 'compacted' : 'active').join(', ')}`)
  console.log('live checkpoints (turn | kind | nextTurn | canFork | prompt):')
  for (const checkpoint of overview.checkpoints) {
    console.log(`   ${String(checkpoint.afterTurn).padEnd(5)} ${String(checkpoint.kind).padEnd(8)} `
      + `${String(checkpoint.hasNextTurn).padEnd(5)} ${String(checkpoint.canFork).padEnd(5)} `
      + `${String(checkpoint.prompt ?? '').replace(/\s+/g, ' ').slice(0, 34)}`)
  }
}

const require_ = createRequire(join(MODULES, 'noop.js'))
const React = require_('react')
const ReactDOMServer = require_('react-dom/server')

globalThis.window = { __ModuleLoader__: { load: (handoff) => { globalThis.__rewindHandoff = handoff } } }
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
}
await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href)
const client = globalThis.__rewindHandoff.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${specifier})`)
})
const t = (key, params) => {
  const value = client.dictionaries.zh[key] ?? key
  if (params === undefined) return value
  return String(value).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? '{' + name + '}'))
}

// The panel folds a long timeline to its newest ten rows. The preview does the
// same, so what it shows matches the app; panel 3 below is expanded on purpose,
// to show the fork in full.
const foldState = client.__internals.folderize(overview?.checkpoints ?? [], false, 10)
const layout = client.buildLayout(overview?.sessions ?? [], foldState.visible, { width: 900 })
const selectedCheckpoint = overview?.checkpoints?.slice(-1)[0]
const renderTree = (selectedId) => ReactDOMServer.renderToStaticMarkup(React.createElement(client.TreeGraph, {
  layout,
  selectedId,
  currentSessionId: overview?.currentSessionId,
  onSelect: () => {},
  // The +/− control beside the rail, exactly as the panel passes it.
  fold: foldState.fold,
  onToggleFold: () => {},
  t,
}))
const tree = renderTree(undefined)
const treeSelected = renderTree(selectedCheckpoint?.id)
const details = ReactDOMServer.renderToStaticMarkup(React.createElement(client.DetailsPane, {
  checkpoint: selectedCheckpoint,
  session: overview?.sessions?.[0],
  workspace: overview?.cwd,
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  // The panel gates re-asking on the row ABOVE the turn, so ask the real helper.
  canReask: client.__internals.reaskAnchorFor(overview?.checkpoints ?? [], selectedCheckpoint) !== undefined,
  onClose: () => {},
}))

// ── what the panel looks like right after "rewind and ask again" ───────────
// Derived from the same live payload with the same flag semantics the host
// applies after a rewind: every checkpoint whose NEXT turn was folded away reads
// `alreadyRewound` (grey, dashed, off-branch), and one new turn is appended for
// the edited prompt. A middle checkpoint is used so the example shows what
// abandoning several turns looks like. This is a rendered example of the
// resulting data shape, not a capture of a live rewind.
const forkable = (overview?.checkpoints ?? []).filter((checkpoint) => checkpoint.canFork === true)
// The turn the user redoes: the next turn of a middle row, so the example shows
// a multi-turn abandonment. Its own prompt is the one being edited, and the row
// above it (the previous turn's checkpoint) is the rewind anchor — exactly what
// the panel's gold button does.
const redoTarget = forkable[Math.floor(forkable.length / 2)]
const lastTurn = (overview?.checkpoints ?? []).reduce((max, checkpoint) => Math.max(max, checkpoint.afterTurn ?? 0), 0)
const rewindFromTurn = redoTarget === undefined ? undefined : (redoTarget.afterTurn ?? 0) + 1
const newTurn = lastTurn + 1
const editedPrompt = redoTarget === undefined
  ? ''
  : `${String((overview.checkpoints.find((checkpoint) => checkpoint.afterTurn === rewindFromTurn) ?? redoTarget).prompt ?? '').trim()}（这次先给结论，再给步骤，并附一个最小复现）`
const abandonedTurns = []
for (let turn = rewindFromTurn ?? 0; turn <= lastTurn; turn += 1) abandonedTurns.push(turn)
const afterRewind = redoTarget === undefined ? undefined : {
  ...overview,
  checkpoints: [
    ...overview.checkpoints.map((checkpoint) => {
      const afterTurn = checkpoint.afterTurn ?? 0
      const nextTurn = afterTurn + 1
      // A turn the rewind folded away: this checkpoint can no longer be rewound.
      // Only an exact integer turn matches, exactly as the host resolves it, so a
      // backup row at turn+0.5 is not dragged into the abandoned branch.
      const cutsNext = Number.isInteger(afterTurn) && nextTurn >= rewindFromTurn && nextTurn <= lastTurn
      // A row that itself stands for a folded-away turn is dead wood, even when a
      // later turn (the appended one) makes its next slot live again.
      const insideRun = Number.isInteger(afterTurn) && afterTurn >= rewindFromTurn && afterTurn <= lastTurn
      if (!cutsNext && !insideRun) return checkpoint
      return {
        ...checkpoint,
        ...(cutsNext
          ? {
            alreadyRewound: true,
            compacted: false,
            promptReplaced: false,
            replacedByOther: false,
            reachable: false,
            canFork: false,
            hasNextTurn: false,
          }
          : {}),
        ...(insideRun ? { ownTurnRewound: true, ownTurnSurfaced: false } : {}),
        abandoned: true,
      }
    }),
    {
      id: 'cp-example-after-rewind',
      sessionId: overview.currentSessionId,
      afterTurn: newTurn,
      kind: 'auto',
      label: '自动',
      prompt: editedPrompt,
      createdAt: Date.now(),
      manifest: true,
      degraded: false,
      stats: { files: 27, bytes: 402653, skipped: 0, truncated: false, roots: 1 },
      roots: overview.roots ?? [],
      rootsCount: (overview.roots ?? []).length,
      live: true,
      forkAtSeq: 999999,
      canFork: false,
      hasNextTurn: false,
      alreadyRewound: false,
      compacted: false,
      promptReplaced: false,
      replacedByOther: false,
      reachable: false,
      abandoned: false,
      droppedTurns: 0,
      canRestoreWorkspace: true,
    },
  ],
}
const afterLayout = afterRewind === undefined
  ? undefined
  : client.buildLayout(afterRewind.sessions, afterRewind.checkpoints, { width: 900 })
const treeAfter = afterLayout === undefined ? '' : ReactDOMServer.renderToStaticMarkup(React.createElement(client.TreeGraph, {
  layout: afterLayout,
  selectedId: undefined,
  currentSessionId: afterRewind.currentSessionId,
  onSelect: () => {},
  t,
}))

// A faithful static replica of the panel chrome, so the preview shows the real
// composition (legend bar, scrolling timeline, details column, action footer)
// rather than a detached graph. Two panels are rendered: the default state with
// nothing selected, and the state after picking a checkpoint.
const legendItem = (label, color) => `<span><i style="background:${color}"></i>${label}</span>`
const legend = [
  legendItem(t('panel.legend.snapshot'), 'var(--rw-ok)'),
  legendItem(t('panel.legend.conversationOnly'), 'var(--rw-accent)'),
  legendItem(t('panel.legend.safety'), 'var(--rw-warn)'),
  legendItem(t('panel.legend.abandoned'), 'var(--rw-fg-3)'),
  `<div class="rw-legend-hint">${t('panel.selectHint')}</div>`,
].join('')
const button = (label, variant) => `<button class="rw-btn" type="button"${variant === undefined ? '' : ` data-variant="${variant}"`}>${label}</button>`
const roots = overview?.roots ?? []
const header = `<div class="rw-head">
  <div class="rw-title">${t('panel.title')}</div>
  <div class="rw-sub" style="max-width:44ch">${roots.length > 0 ? `${t('panel.roots')}: ${roots[0]}` : (overview?.cwd ?? '')}</div>
  ${overview?.autoSelected === true ? `<span class="rw-badge">${t('panel.autoSelected')}</span>` : ''}
  <div class="rw-spacer"></div>
</div>`
const footer = `<div class="rw-foot">
  ${button(t('action.snapshot'))}
  ${button(t('action.refresh'))}
  ${button(t('action.gc'))}
  <div class="rw-spacer"></div>
  <span>${(overview?.checkpoints ?? []).length} ${t('panel.checkpoints')}</span>
  <span class="rw-mono">rewind/v1</span>
  <span class="rw-build" title="client ">v+</span>
  <a class="rw-btn rw-author" data-variant="quiet" href="${client.author.repository}" target="_blank" rel="noreferrer noopener"
     title="${client.author.name} · ${client.author.repository}">
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" style="flex:none;display:block">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
    <span>${client.author.name}</span>
  </a>
  ${button(t('action.close'), 'quiet')}
</div>`
// The same fold row the panel draws above a folded timeline. Panel 3 passes its
// own (expanded) graph, so it gets no fold row.
const foldRow = foldState.fold === undefined ? 0 : foldState.fold.count === 0 ? '' : `<button class="rw-fold" type="button">`
  + '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="flex:none;display:block">'
  + '<path fill="currentColor" d="M7 2.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM7 5.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM7 9.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/></svg>'
  + `<span>${t('panel.foldOlder').replace('{count}', String(foldState.fold === undefined ? 0 : foldState.fold.count))}</span></button>`
const panel = (graph, side) => `<div class="drawer">
  ${header}
  <div class="body">
    <div class="graph">
      <div class="rw-legend">${legend}</div>
      <div class="scroll">${graph === treeAfter ? '' : foldRow}${graph}</div>
    </div>
    ${side}
  </div>
  ${footer}
</div>`

const previewDir = join(here, '..', 'preview')
await fs.mkdir(previewDir, { recursive: true })
const outPath = join(previewDir, 'panel-preview.html')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-plugin-rewind 面板预览</title>
<style>
html,body{height:100%}
body{margin:0;background:#101013;color:#f2f2f3;font:13px/20px system-ui,'Segoe UI',sans-serif}
.page{padding:16px 16px 24px 16px;display:flex;flex-direction:column;gap:10px;align-items:flex-end}
h1{font-size:15px;margin:0;align-self:flex-start}
p{margin:0 0 6px 0;color:#84848c;font-size:12px;align-self:flex-start}
.caption{color:#84848c;font-size:12px;align-self:flex-end}
.drawer{height:620px;width:min(1240px,100%);background:var(--rw-bg);border:1px solid var(--rw-line);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
.body{display:flex;flex:1 1 auto;min-height:0}
.graph{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;background:var(--rw-bg-2)}
.scroll{flex:1 1 auto;min-height:0;overflow:auto}
.side{flex:0 0 336px;border-left:1px solid var(--rw-line);padding:12px 14px 16px 14px;overflow:auto;background:var(--rw-bg)}
/* A mock of the product's composer, to show what "continue after the rewind"
   looks like next to the panel. Not part of the plugin's own UI. */
.chat{width:min(1240px,100%);display:flex;flex-direction:column;gap:8px}
.bubble{align-self:flex-start;max-width:70%;background:var(--rw-bg-3);border:1px solid var(--rw-line);border-radius:12px;padding:9px 12px;font-size:12.5px}
.bubble[data-role=user]{align-self:flex-end;background:rgba(217,161,58,.16);border-color:rgba(217,161,58,.5)}
.bubble[data-role=ghost]{border-style:dashed;color:#84848c;background:transparent}
.composer{display:flex;gap:8px;align-items:flex-end;background:var(--rw-bg-3);border:1px solid var(--rw-line);border-radius:12px;padding:9px 10px}
.composer .text{flex:1 1 auto;font-size:12.5px;white-space:pre-wrap;color:var(--rw-fg-2)}
.composer[data-state=sending]{border-color:rgba(217,161,58,.6)}
.note{color:#84848c;font-size:11.5px}
${client.css ?? ''}
</style></head>
<body><div class="page rw-root">
<h1>对话回退 / 工作区回滚 — 面板预览</h1>
<p>由 test/live-forensics.mjs 用真实检查点数据渲染（react-dom/server + 插件自身的样式表），不是运行中的界面截图。</p>
<div class="caption">① 默认状态：只有时间线，详情不显示（点选检查点才出现）</div>
${panel(tree, '')}
<div class="caption">② 选中某个检查点：右侧出现详情；提问可编辑，金色按钮＝回退并重新提问</div>
${panel(treeSelected, `<div class="side">${details}</div>`)}
<div class="caption">③ 点了金色按钮之后（此块展开全部轮次以看清分叉；示例：回退到第 ${rewindFromTurn} 轮之前并改写提问）：第 ${rewindFromTurn}–${lastTurn} 轮变灰＋虚线＋「已回退」，底部新增第 ${newTurn} 轮</div>
${panel(treeAfter, '')}
<div class="chat">
  <div class="note">下面是聊天区的示意（产品自带的输入框，不属于插件 UI）：回退后插件把改写的提问放进输入框并提交。</div>
  <div class="bubble" data-role=ghost">（被回退的第 ${rewindFromTurn}–${lastTurn} 轮不再出现在模型的可见历史里；聊天记录里已显示的原文不会消失，日志与树图都完整保留）</div>
  <div class="bubble" data-role=user>${editedPrompt || '（示例：改写后的提问）'}</div>
  <div class="composer" data-state=sending>
    <div class="text">${editedPrompt || '（示例：改写后的提问）'}</div>
    <button class="rw-btn" data-variant="gold" type="button">${t('action.reask')}</button>
  </div>
  <div class="note">金色按钮与面板内的是同一个：先回退，再把这段提问发送成新一轮。</div>
</div>
</div></body></html>`
await fs.writeFile(outPath, html, 'utf8')
console.log(`preview written: ${outPath}`)
console.log(`tree markup: ${tree.length} bytes, nodes=${(tree.match(/class="rw-node"/g) ?? []).length}, lanes=${(layout.lanes ?? []).length}, rows=${(layout.rows ?? []).length}, cardX=${layout.cardX}, cardW=${layout.cardW}`)
console.log(`after-rewind example: rewound from turn ${rewindFromTurn}, appended turn ${newTurn ?? lastTurn + 1}, nodes=${afterLayout === undefined ? 0 : afterLayout.nodes.length}`)
if (afterRewind !== undefined) {
  // The example's own data, so the picture can be checked without reading SVG.
  for (const checkpoint of afterRewind.checkpoints) {
    const state = checkpoint.kind === 'safety'
      ? 'backup'
      : checkpoint.ownTurnRewound === true
        ? 'dead-wood'
        : checkpoint.alreadyRewound === true
          ? 'cut-here'
          : checkpoint.hasNextTurn === true ? 'rewindable' : 'tail'
    const prompt = String(checkpoint.prompt ?? '').replace(/\s+/g, ' ').slice(0, 40)
    console.log(`   turn ${String(checkpoint.afterTurn).padEnd(5)} ${state.padEnd(11)} ${prompt}`)
  }
}
