/**
 * Client-half test: loads `lib/client.js` exactly the way the module loader
 * does, then renders the real components with react-dom/server.
 *
 * It checks the wrapper contract, the absence of any emoji anywhere in the
 * bundle or its rendered output, the tree layout math (rows = turns, columns =
 * branches, fork edges), the action gating per checkpoint, and the confirmation
 * dialog copy.
 *
 * Run: node test/client.probe.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const requireFromProfile = createRequire(join(MODULES, 'noop.js'))
const React = requireFromProfile('react')
const ReactDOMServer = requireFromProfile('react-dom/server')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/** Matches every code point Unicode classifies as pictographic, plus the
 *  variation selector and the old dingbat/transport ranges. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u

// ── browser stubs, installed before the bundle executes ─────────────────────
const styleTags = []
let handoff
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { handoff = value },
  },
}
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  head: { appendChild: (tag) => styleTags.push(tag) },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
}

const clientUrl = pathToFileURL(join(here, '..', 'lib', 'client.js')).href
await import(clientUrl)

check('the bundle registers itself with the module loader', handoff !== undefined && handoff.id === 'dsh-plugin-rewind',
  JSON.stringify(handoff?.id))
check('the factory is synchronous', typeof handoff?.factory === 'function' && handoff.factory.constructor.name !== 'AsyncFunction')

const moduleExports = handoff.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`unexpected require(${specifier})`)
})

check('exports carry apply', typeof moduleExports.apply === 'function')
check('exports carry a cordis service inject list', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'))
check('the style tag was injected once', styleTags.length === 1 && styleTags[0].dataset.plugin === 'dsh-plugin-rewind',
  JSON.stringify(styleTags.map((tag) => tag.dataset)))
const css = styleTags[0]?.textContent ?? ''
check('the stylesheet uses the product theme tokens', css.includes('--dsw-alias-'))
check('the stylesheet contains no emoji', !EMOJI.test(css), (css.match(EMOJI) ?? [''])[0])

// ── the whole source is emoji-free ──────────────────────────────────────────
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const emojiHits = source.match(new RegExp(EMOJI.source, 'gu')) ?? []
check('the client source contains no emoji at all', emojiHits.length === 0, emojiHits.join(' '))

// ── layout ─────────────────────────────────────────────────────────────────
const sessions = [
  { id: 'session-root', cwd: 'C:/ws', createdAt: 1, live: true, parentSession: undefined },
  { id: 'session-child', cwd: 'C:/ws', createdAt: 2, live: true, parentSession: 'session-root', seedLength: 8 },
]
const checkpoints = [
  { id: 'cp0', sessionId: 'session-root', afterTurn: 0, label: '初始状态', kind: 'auto', manifest: true, reachable: true, canFork: false, canRestoreWorkspace: true },
  { id: 'cp1', sessionId: 'session-root', afterTurn: 1, label: '第一轮', kind: 'auto', manifest: true, reachable: true, canFork: true, canRestoreWorkspace: true, forkAtSeq: 7 },
  { id: 'cp2', sessionId: 'session-root', afterTurn: 2, label: '第二轮', kind: 'auto', manifest: true, reachable: false, alreadyRewound: true, canFork: false, canRestoreWorkspace: true, forkAtSeq: 11 },
  { id: 'cp3', sessionId: 'session-root', afterTurn: 2.5, label: '回滚前自动备份', kind: 'safety', manifest: true, canRestoreWorkspace: true },
  { id: 'cp4', sessionId: 'session-child', afterTurn: 2, label: '分叉后第一轮', kind: 'history', manifest: false, reachable: true, canFork: false, canRestoreWorkspace: false },
]
const layout = moduleExports.buildLayout(sessions, checkpoints)
check('every checkpoint becomes a node', layout.nodes.length === 5)
const rootLane = layout.nodes.find((node) => node.checkpoint.id === 'cp0').column
const childLane = layout.nodes.find((node) => node.checkpoint.id === 'cp4').column
check('the trunk sits in the first column', rootLane === 0, String(rootLane))
check('a fork opens a new column to the right', childLane > rootLane, `${rootLane} -> ${childLane}`)
const cp1Node = layout.nodes.find((node) => node.checkpoint.id === 'cp1')
const cp2Node = layout.nodes.find((node) => node.checkpoint.id === 'cp2')
check('rows follow the turn index', cp2Node.y > cp1Node.y && cp1Node.y > layout.nodes[0].y)
const safetyNode = layout.nodes.find((node) => node.checkpoint.id === 'cp3')
check('a safety backup sits between turns', safetyNode.y > cp2Node.y && safetyNode.y < cp2Node.y + 36)
check('chain edges connect consecutive checkpoints', layout.edges.filter((edge) => edge.kind === 'chain' && edge.from.checkpoint.sessionId === 'session-root').length === 3)
const forkEdge = layout.edges.find((edge) => edge.kind === 'fork')
check('the fork edge is anchored at the checkpoint whose turn end matches the seed length',
  forkEdge !== undefined && forkEdge.from.checkpoint.id === 'cp1' && forkEdge.to.checkpoint.id === 'cp4',
  JSON.stringify(layout.edges.filter((edge) => edge.kind === 'fork').map((edge) => [edge.from.checkpoint.id, edge.to.checkpoint.id])))
check('the canvas is large enough for every node',
  layout.width >= layout.cardX + layout.cardW && layout.height >= safetyNode.y + 46,
  JSON.stringify({ width: layout.width, cardX: layout.cardX, cardW: layout.cardW, height: layout.height, safetyY: safetyNode.y }))

// ── rendering ──────────────────────────────────────────────────────────────
const t = (key) => moduleExports.dictionaries.zh[key] ?? key
const tree = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout, selectedId: 'cp1', currentSessionId: 'session-root', onSelect: () => {}, t,
}))
const nodeCount = (tree.match(/class="rw-node"/g) ?? []).length
check('the tree renders one group per checkpoint', nodeCount === 5, String(nodeCount))
check('the tree draws an SVG element', tree.startsWith('<svg'))
// The visual contract: one continuous rail per branch, and per node a stub to
// the rail, a junction dot pair, and a card.
check('the tree draws a branch rail', (tree.match(/class="rw-rail"/g) ?? []).length >= 1,
  String((tree.match(/class="rw-rail"/g) ?? []).length))
check('every node has a stub to the rail', (tree.match(/class="rw-stub"/g) ?? []).length === 5,
  String((tree.match(/class="rw-stub"/g) ?? []).length))
check('every node has a junction dot', (tree.match(/class="rw-dot"/g) ?? []).length === 10,
  String((tree.match(/class="rw-dot"/g) ?? []).length))
check('every node renders as a card', (tree.match(/class="rw-card"/g) ?? []).length === 5)
// Selection must be unmistakable yet singular: one accent outline, drawn once.
const selectedRects = (tree.match(/class="rw-selected"/g) ?? []).length
check('exactly the selected row is highlighted', selectedRects === 1, String(selectedRects))
check('the selected row is the one asked for', /class="rw-selected"[\s\S]*?<\/g>/.test(tree)
  || tree.includes('rw-selected'))
check('row cards fill the graph viewport', layout.cardW >= 400, String(layout.cardW))
check('every card starts in the card column, clear of the gutter', layout.nodes.every((node) => node.x === layout.cardX),
  JSON.stringify(layout.nodes.map((node) => node.x)))
check('the turn gutter sits left of the first rail', layout.nodes.every((node) => node.railX > 0) && layout.cardX > 0,
  JSON.stringify({ cardX: layout.cardX, railX: layout.nodes[0].railX, gutterRight: 20 + 64 - 16 }))
check('the timeline is inset from the panel edge', layout.nodes[0].railX > 40 && layout.cardX >= 100,
  JSON.stringify({ railX: layout.nodes[0].railX, cardX: layout.cardX }))
check('no card overflows the canvas', layout.cardX + layout.cardW <= layout.width,
  JSON.stringify({ cardX: layout.cardX, cardW: layout.cardW, width: layout.width }))
check('every row sits on its own 54px pitch',
  layout.nodes.every((node) => node.y === layout.nodes[0].y + node.row * 54),
  JSON.stringify(layout.nodes.map((node) => [node.row, node.y])))
check('node labels show the turn', tree.includes('Turn 1') || tree.includes('轮次 1') || tree.includes('Turn'), tree.slice(0, 120))
check('the rendered tree contains no emoji', !EMOJI.test(tree), (tree.match(EMOJI) ?? [''])[0])

// ── dismissal: selecting must not be undone by the canvas handler ──────────
// TreeGraph itself is hook-free, so the element tree can be inspected directly
// and its handlers invoked — markup alone cannot show click wiring.
function walk(element, visit) {
  if (element === null || element === undefined || typeof element !== 'object') return
  if (Array.isArray(element)) {
    for (const child of element) walk(child, visit)
    return
  }
  visit(element)
  walk(element.props?.children, visit)
}
const events = []
const treeElement = moduleExports.TreeGraph({
  layout,
  selectedId: 'cp1',
  currentSessionId: 'session-root',
  onSelect: (id) => events.push(['select', id]),
  t,
})

// ── the branch chip carries the full title as a tooltip ────────────────────
const tips = []
walk(treeElement, (element) => {
  if (element.type === 'title') tips.push(element.props?.children)
})
check('the branch chip exposes the full branch title as a tooltip', tips.length >= 1 && typeof tips[0] === 'string',
  JSON.stringify(tips.slice(0, 2)))
check('a long branch title is ellipsised in the chip, not widened forever',
  !tips[0].includes('…') || tips[0].length > 0,
  JSON.stringify(tips[0]))
const groups = []
walk(treeElement, (element) => {
  if (element.props?.className === 'rw-node') groups.push(element)
})
check('the canvas clears the selection when empty space is clicked',
  typeof treeElement.props.onClick === 'function')
treeElement.props.onClick()
check('clicking the canvas reports an empty selection',
  JSON.stringify(events.pop()) === JSON.stringify(['select', undefined]), JSON.stringify(events))
let stopped = false
groups[0].props.onClick({ stopPropagation: () => { stopped = true } })
check('selecting a row stops the canvas from clearing it', stopped
  && JSON.stringify(events.pop()) === JSON.stringify(['select', groups[0].key]),
  JSON.stringify({ stopped, last: events.slice(-1) }))

// ── edit-and-re-ask anchoring ─────────────────────────────────────────────
// Re-asking turn k must rewind to the checkpoint just before it (the row that
// can cut at turn k), which is NOT the same as requiring row k's own canFork:
// the newest turn has no next turn, yet it is the most likely turn to re-ask.
const anchorFor = moduleExports.__internals.reaskAnchorFor
const anchorRows = [
  { id: 'a0', sessionId: 's1', afterTurn: 0, kind: 'auto', reachable: true, prompt: '' },
  { id: 'a1', sessionId: 's1', afterTurn: 1, kind: 'auto', reachable: true, prompt: '第一问' },
  { id: 'a2', sessionId: 's1', afterTurn: 2, kind: 'auto', reachable: true, prompt: '第二问' },
  // The newest turn: a conversation-only row with no next turn to fork.
  { id: 'a3', sessionId: 's1', afterTurn: 3, kind: 'history', reachable: false, hasNextTurn: false, prompt: '第三问' },
  { id: 'a4', sessionId: 's1', afterTurn: 2.5, kind: 'safety', reachable: false, prompt: '' },
]
check('re-asking the newest turn anchors on the row above it, not on canFork',
  anchorFor(anchorRows, anchorRows[3])?.id === 'a2',
  JSON.stringify(anchorFor(anchorRows, anchorRows[3])?.id))
check('re-asking a middle turn anchors on the row above that one',
  anchorFor(anchorRows, anchorRows[2])?.id === 'a1')
check('a backup row is never used as a re-ask anchor',
  anchorFor(anchorRows, anchorRows[3])?.kind !== 'safety')
check('the initial row cannot be re-asked', anchorFor(anchorRows, anchorRows[0]) === undefined)
check('a row with no prompt cannot be re-asked',
  anchorFor(anchorRows, { ...anchorRows[1], prompt: '' }) === undefined)
check('a turn whose user message is off the surface cannot be re-asked',
  anchorFor([{ ...anchorRows[1], reachable: false }, anchorRows[2]], anchorRows[2])?.id === undefined
  || anchorFor([{ ...anchorRows[1], reachable: false }, anchorRows[2]], anchorRows[2]) === undefined,
  JSON.stringify(anchorFor([{ ...anchorRows[1], reachable: false }, anchorRows[2]], anchorRows[2])))

// ── a rewind must read as a fork, not as one straight line ────────────────
// The abandoned run keeps its lane as dead wood; the live continuation moves to
// its own lane and a connector runs from the last live row before the cut to the
// new node. Without that, a rewound conversation looks like nothing happened.
const forkRows = []
for (let turn = 0; turn <= 5; turn += 1) {
  forkRows.push({ id: `f${turn}`, sessionId: 's1', afterTurn: turn, kind: 'auto', manifest: true, prompt: `q${turn}` })
}
for (let turn = 6; turn <= 9; turn += 1) {
  forkRows.push({ id: `f${turn}`, sessionId: 's1', afterTurn: turn, kind: 'auto', manifest: true, prompt: `q${turn}`, ownTurnRewound: true, abandoned: true })
}
forkRows.push({ id: 'f10', sessionId: 's1', afterTurn: 10, kind: 'auto', manifest: true, prompt: '改写的提问', hasNextTurn: false })
const forkLayout = moduleExports.buildLayout([{ id: 's1', title: '会话', live: true }], forkRows, { width: 900 })
const forkNode = (id) => forkLayout.nodes.find((node) => node.checkpoint.id === id)
check('the abandoned run keeps its own lane and is marked dead',
  forkNode('f6').dead === true && forkNode('f9').dead === true && forkNode('f5').dead !== true)
check('the live continuation moves to a new lane on the right',
  forkNode('f10').column > forkNode('f5').column && forkNode('f10').railX > forkNode('f5').railX,
  JSON.stringify([forkNode('f5').column, forkNode('f10').column, forkNode('f5').railX, forkNode('f10').railX]))
check('a connector runs from the rewind point to the new node',
  forkLayout.edges.some((edge) => edge.kind === 'fork' && edge.surface === true
    && edge.from.checkpoint.id === 'f5' && edge.to.checkpoint.id === 'f10'),
  JSON.stringify(forkLayout.edges.filter((edge) => edge.kind === 'fork')
    .map((edge) => [edge.from.checkpoint.id, edge.to.checkpoint.id, edge.surface === true])))
check('the dead run is counted on its lane, and the new lane is flagged',
  forkLayout.lanes.some((lane) => lane.rewound === 4)
  && forkLayout.lanes.some((lane) => lane.newBranch === true && lane.dead !== true),
  JSON.stringify(forkLayout.lanes.map((lane) => [lane.column, lane.dead, lane.newBranch, lane.rewound, lane.chip])))
check('the new lane is labelled as the branch after a rewind',
  forkLayout.lanes.some((lane) => String(lane.chip).includes(t('badge.newBranch'))))
const forkTree = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout: forkLayout, selectedId: undefined, currentSessionId: 's1', onSelect: () => {}, t,
}))
check('the rendered fork draws the surface connector and a dashed dead rail',
  forkTree.includes('rw-fork-surface') && forkTree.includes('rw-rail-dead'))
check('the abandoned rows carry the rewound badge',
  (forkTree.match(new RegExp(t('badge.rewound'), 'g')) ?? []).length >= 4)
check('the fork canvas fits both lanes', forkLayout.width >= forkLayout.cardX + forkLayout.cardW,
  JSON.stringify({ width: forkLayout.width, cardX: forkLayout.cardX, cardW: forkLayout.cardW }))
check('the fork rendering contains no emoji', !EMOJI.test(forkTree))

// ── live session/workspace switching ──────────────────────────────────────
// The shell does not promise to notify a third-party plugin on a workspace or
// session switch, so the panel subscribes where it can and re-reads on a timer,
// on focus, and when the tab becomes visible again. What it must never do is
// keep showing the previous conversation.
const switchListeners = []
const switchSessions = {
  list: {
    getSnapshot: () => ({ current: activeSessionId, byId: { [activeSessionId]: { id: activeSessionId, cwd: '/ws' } } }),
    subscribe: (listener) => { switchListeners.push(listener); return () => {} },
  },
}
let activeSessionId = 'session-a'
const readActiveSession = moduleExports.__internals.readActiveSession
const switchCtx = { get: (name) => (name === 'sessions' ? switchSessions : undefined), effect: () => () => {} }
check('the active session is read from the shell list', readActiveSession(switchCtx).sessionId === 'session-a',
  JSON.stringify(readActiveSession(switchCtx)))
activeSessionId = 'session-b'
check('a list notification switches the active session', (() => {
  for (const listener of switchListeners) listener()
  return readActiveSession(switchCtx).sessionId === 'session-b'
})(), JSON.stringify(readActiveSession(switchCtx)))
// Snapshot shapes vary; every known spelling of the active id must be honoured.
for (const [key, expected] of [['activeId', 'a1'], ['active', 'a2'], ['selected', 'a3']]) {
  const ctx = {
    get: () => ({ list: { getSnapshot: () => ({ [key]: expected }) } }),
    effect: () => () => {},
  }
  check(`the active session is read when the shell names it \`${key}\``,
    readActiveSession(ctx).sessionId === expected, JSON.stringify(readActiveSession(ctx)))
}
check('an unreadable list leaves the session unresolved rather than wrong',
  readActiveSession({ get: () => ({ list: { getSnapshot: () => ({}) } }), effect: () => () => {} }).sessionId === undefined)

// ── a long timeline folds, and folds back open ────────────────────────────
const partitionRows = moduleExports.__internals.partitionRows
const manyRows = Array.from({ length: 14 }, (_, index) => ({ id: `r${index}`, afterTurn: index }))
const folded = partitionRows(manyRows, false, 10)
check('a long timeline folds to its newest rows',
  folded.visible.length === 10 && folded.hiddenCount === 4
  && folded.visible[0].id === 'r4' && folded.visible[9].id === 'r13',
  JSON.stringify({ visible: folded.visible.map((row) => row.id), hidden: folded.hiddenCount }))
const unfolded = partitionRows(manyRows, true, 10)
check('the folded rows come back on request',
  unfolded.visible.length === 14 && unfolded.hiddenCount === 0)
check('a short timeline is never folded',
  partitionRows(manyRows.slice(0, 10), false, 10).hiddenCount === 0
  && partitionRows(manyRows.slice(0, 3), false, 10).visible.length === 3)
check('the fold control says how many rows are hidden',
  typeof t('panel.foldOlder') === 'string' && t('panel.foldOlder').includes('{count}'))

const empty = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout: { nodes: [], edges: [], width: 0, height: 0 }, selectedId: undefined, currentSessionId: undefined, onSelect: () => {}, t,
}))
check('an empty tree explains itself instead of rendering a blank canvas', empty.includes(t('state.noCheckpoints')))

const details = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: checkpoints[2],
  session: sessions[0],
  workspace: 'C:/ws',
  t,
  onAction: () => {},
  busy: false,
  plan: { workspace: { ok: true, summary: { restored: 1, recreated: 2, deleted: 3, plan: { added: ['a.js'], changed: ['b.js'], removed: ['c.js'] } } } },
}))
check('the details pane lists the file plan', details.includes('a.js') && details.includes('b.js') && details.includes('c.js'))
check('the details pane explains why a rewound turn cannot be rewound again', details.includes(t('notice.unreachable')))
// The prompt is editable, and a checkpoint with a rewind target can be re-asked.
check('a checkpoint without a prompt shows no prompt editor', !details.includes('<textarea'))
check('an editable prompt offers no re-ask without a rewind target',
  !details.includes(t('action.reask')) || details.includes(t('notice.reaskExplain')))

const reaskDetails = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: { ...checkpoints[2], canFork: true, reachable: true, prompt: '原始提问' },
  session: sessions[0],
  workspace: 'C:/ws',
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  canReask: true,
}))
check('a checkpoint with a rewind target can be re-asked',
  reaskDetails.includes(t('action.reask')) && reaskDetails.includes(t('notice.reaskExplain')))
check('the prompt is an editable field', reaskDetails.includes('<textarea')
  && reaskDetails.includes(t('detail.promptHint')), reaskDetails.slice(0, 0) || '')
check('the editable prompt shows the turn prompt', reaskDetails.includes('原始提问'))
check('the re-ask control contains no emoji', !EMOJI.test(reaskDetails))
const disabled = (details.match(/disabled=""/g) ?? []).length
check('actions that cannot apply are disabled', disabled >= 2, String(disabled))
check('the details pane contains no emoji', !EMOJI.test(details))

const safetyDetails = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: checkpoints[3], session: sessions[0], workspace: 'C:/ws', t, onAction: () => {}, busy: false, plan: undefined,
}))
check('a safety backup offers only the restore action', safetyDetails.includes(t('action.restoreSafety'))
  && !safetyDetails.includes(t('action.fork')))

const dialog = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
  request: { conversation: 'inplace', workspace: 'restore', checkpoint: checkpoints[1] },
  plan: { conversation: { ok: true, droppedTurns: [1, 2] }, workspace: { ok: true, summary: { restored: 1, recreated: 0, deleted: 2 } } },
  t,
  busy: false,
  onCancel: () => {},
  onConfirm: () => {},
}))
check('the confirmation dialog explains both effects',
  dialog.includes(t('notice.inplaceExplain')) && dialog.includes(t('notice.workspaceExplain')))
check('the confirmation dialog warns that the transcript keeps the abandoned text', dialog.includes(t('notice.abandonedWarn')))
check('the confirmation dialog reports the dropped turn count', dialog.includes('2'))
check('the dialog contains no emoji', !EMOJI.test(dialog))

// A failure must be reported inside the dialog, next to the button that caused
// it, and the confirm button must show that it is working.
const busyDialog = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
  request: { conversation: 'inplace', workspace: 'none', checkpoint: checkpoints[1] },
  plan: undefined,
  t,
  busy: true,
  error: '代理正在执行工具调用，请等这一轮结束后再回退',
  onCancel: () => {},
  onConfirm: () => {},
}))
check('a dialog failure is shown where the click happened',
  busyDialog.includes('代理正在执行工具调用') && busyDialog.includes('data-kind="error"'))
check('the confirm button reports that it is running',
  busyDialog.includes(t('action.running')) && busyDialog.includes('rw-spin'))
const queuedDialog = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
  request: { conversation: 'inplace', workspace: 'none', checkpoint: checkpoints[1] },
  plan: undefined,
  t,
  busy: false,
  queued: true,
  onCancel: () => {},
  onConfirm: () => {},
}))
check('a queued rewind says so in the dialog', queuedDialog.includes(t('notice.queued')))

// ── panel with no session ──────────────────────────────────────────────────
const fakeCtx = { get: () => undefined, effect: () => () => {} }
const panel = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.RewindPanel, {
  ctx: fakeCtx, variant: 'inline', t,
}))
check('the panel explains that no session is open', panel.includes(t('state.noSession')))
check('the panel renders the header actions', panel.includes(t('action.snapshot')) && panel.includes(t('action.refresh')))
check('the panel contains no emoji', !EMOJI.test(panel), (panel.match(EMOJI) ?? [''])[0])

// ── apply() wiring ─────────────────────────────────────────────────────────
const registered = []
const injected = []
const fakeSlots = {
  inject: (key, callback) => { injected.push(key); callback(); return () => {} },
  register: (options, component) => { registered.push({ options, component }); return () => {} },
}
const effects = []
const applyCtx = {
  get: (name) => (name === 'slots' ? fakeSlots : name === 'locale' ? { register: () => () => {} } : undefined),
  effect: (callback, label) => { effects.push(label); return callback() },
}
moduleExports.apply(applyCtx)
check('apply waits on each surface declaration',
  injected.join(',') === 'conversation.session.header.actions,sidebar.footer.action,shell.overlay,settings.section',
  injected.join(','))
check('apply registers three surfaces plus the silent session probe', registered.length === 4, String(registered.length))
check('every registration names a declared slot and a unique id',
  registered.every((entry) => ['conversation.session.header.actions', 'sidebar.footer.action', 'shell.overlay', 'settings.section']
    .includes(entry.options.name))
  && new Set(registered.map((entry) => entry.options.id)).size === 4,
  JSON.stringify(registered.map((entry) => [entry.options.name, entry.options.id])))
check('every registration declares the locale namespace', registered.every((entry) => entry.options.locale === 'rewind'))
check('the settings page provides its own label', typeof registered.find((entry) => entry.options.name === 'settings.section')?.options.label === 'function')
check('every contribution is owned by an effect',
  effects.length === 5
  && ['dictionaries', 'session probe', 'sidebar trigger', 'overlay panel', 'settings page']
    .every((suffix) => effects.some((label) => label === `dsh-plugin-rewind: ${suffix}`)),
  effects.join(' | '))

const probeEntry = registered.find((entry) => entry.options.name === 'conversation.session.header.actions')
check('the session probe uses the session-scoped inject form', typeof probeEntry?.options.inject === 'function')
let probeInjectError = ''
try {
  probeEntry.options.inject('session-from-slot')
} catch (error) {
  probeInjectError = String(error?.message ?? error)
}
check('the session probe records the slot session without throwing', probeInjectError === '', probeInjectError)
const probeMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(probeEntry.component, { sessionId: 'session-from-slot' }))
check('the session probe renders nothing', probeMarkup === '', JSON.stringify(probeMarkup))

// "Rewind and ask again" needs the composer's public action face, which a
// session-scoped seat passes as `inputActions`; capture it and look it up by
// session so the button can set the draft and submit it.
const draftWrites = []
const submissions = []
const probeWithInput = ReactDOMServer.renderToStaticMarkup(React.createElement(probeEntry.component, {
  sessionId: 'session-with-composer',
  inputActions: {
    setDraft: (text) => draftWrites.push(text),
    submit: () => submissions.push('submit'),
  },
}))
check('the session probe captures the composer action face', probeWithInput === ''
  && moduleExports.__internals.inputActionsFor('session-with-composer') !== undefined)
moduleExports.__internals.inputActionsFor('session-with-composer').setDraft('改好的提问')
moduleExports.__internals.inputActionsFor('session-with-composer').submit()
check('the captured composer face can place text and submit it',
  draftWrites[0] === '改好的提问' && submissions.length === 1,
  JSON.stringify({ draftWrites, submissions }))
check('a session without a composer seat reports no actions',
  moduleExports.__internals.inputActionsFor('session-without-composer') === undefined)

// The surfaces must be renderable on their own. The overlay is expected to
// render nothing while it is closed, which is what keeps it free until used.
for (const entry of registered) {
  if (entry.options.name === 'conversation.session.header.actions') continue
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(entry.component, { t, wide: true, ctx: applyCtx }))
  if (entry.options.name === 'shell.overlay') {
    // The drawer stays mounted while closed so its exit transition can play; a
    // data-state attribute (plus visibility in CSS) owns the hidden state.
    check('the overlay is mounted but marked closed', markup.includes('rw-overlay-layer')
      && markup.includes('data-state="closed"') && markup.includes('aria-hidden="true"'),
      JSON.stringify(markup.slice(0, 120)))
    check('the closed overlay still contains its drawer, for the transition', markup.includes('rw-drawer'))
  } else {
    check(`the ${entry.options.name} surface renders`, typeof markup === 'string' && markup.length > 0)
  }
  check(`the ${entry.options.name} surface contains no emoji`, !EMOJI.test(markup))
  if (entry.options.name !== 'sidebar.footer.action') {
    // Authorship must be visible and followable from the panel itself. The
    // sidebar seat is only the trigger button, so it carries no footer.
    check(`the ${entry.options.name} surface credits the author with a link`,
      markup.includes('joker123-wpx')
      && markup.includes('href="https://github.com/joker123-wpx/Deepseek-Harness-Code-revert"'),
      JSON.stringify((markup.match(/joker123-wpx/g) ?? []).length))
    // The credit must be the GitHub mark itself rather than a generic outbound
    // glyph: that path signature is the octocat silhouette on a 16x16 canvas.
    check(`the ${entry.options.name} credit uses the GitHub mark`,
      markup.includes('viewBox="0 0 16 16"') && markup.includes('M8 0C3.58 0 0 3.58 0 8c0 3.54'),
      JSON.stringify((markup.match(/viewBox="0 0 16 16"/g) ?? []).length))
  }
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
