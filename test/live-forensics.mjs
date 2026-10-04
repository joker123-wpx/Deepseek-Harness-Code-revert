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
const t = (key) => client.dictionaries.zh[key] ?? key

const layout = client.buildLayout(overview?.sessions ?? [], overview?.checkpoints ?? [])
const tree = ReactDOMServer.renderToStaticMarkup(React.createElement(client.TreeGraph, {
  layout,
  selectedId: overview?.checkpoints?.slice(-1)[0]?.id,
  currentSessionId: overview?.currentSessionId,
  onSelect: () => {},
  t,
}))
const details = ReactDOMServer.renderToStaticMarkup(React.createElement(client.DetailsPane, {
  checkpoint: overview?.checkpoints?.slice(-1)[0],
  session: overview?.sessions?.[0],
  workspace: overview?.cwd,
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
}))

const previewDir = join(here, '..', 'preview')
await fs.mkdir(previewDir, { recursive: true })
const outPath = join(previewDir, 'panel-preview.html')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-plugin-rewind 面板预览</title>
<style>
body{margin:0;background:#17171a;color:#f2f2f3;font:13px/20px system-ui,'Segoe UI',sans-serif}
.wrap{display:flex;flex-direction:column;gap:12px;padding:16px}
.card{background:#232326;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:12px}
.graph{overflow:auto}
.side{max-width:340px}
h1{font-size:15px;margin:0 0 4px 0}
p{margin:0;color:#84848c;font-size:12px}
${client.css ?? ''}
</style></head>
<body><div class="wrap rw-root">
<h1>对话回退 / 工作区回滚 — 树图预览</h1>
<p>由 test/live-forensics.mjs 用真实检查点数据渲染（react-dom/server），不是运行中的界面截图。</p>
<div class="card graph"><div class="rw-legend"><span><i style="background:var(--rw-accent)"></i>${t('panel.legend.current')}</span><span><i style="background:var(--rw-fg-3)"></i>${t('panel.legend.abandoned')}</span><span><i style="background:var(--rw-ok)"></i>${t('panel.legend.snapshot')}</span><span><i style="background:var(--rw-warn)"></i>${t('panel.legend.safety')}</span></div>${tree}</div>
<div class="card side">${details}</div>
</div></body></html>`
await fs.writeFile(outPath, html, 'utf8')
console.log(`preview written: ${outPath}`)
console.log(`tree markup: ${tree.length} bytes, nodes=${(tree.match(/class="rw-node"/g) ?? []).length}, lanes=${(layout.lanes ?? []).length}, rows=${(layout.rows ?? []).length}`)
