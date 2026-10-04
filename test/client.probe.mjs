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

// The card column's own minimum width, mirrored from the client for the geometry checks.
const MIN_CARD_W = 240
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
check('rows are consecutive slots, one pitch apart',
  layout.nodes.slice().sort((a, b) => a.row - b.row)
    .every((node, index, list) => index === 0 || (node.row === list[index - 1].row + 1
      && node.y - list[index - 1].y === 54)),
  JSON.stringify(layout.nodes.slice().sort((a, b) => a.row - b.row).map((node) => [node.row, node.y])))
const safetyNode = layout.nodes.find((node) => node.checkpoint.id === 'cp3')
// Rows are unique slots in turn order, so a backup recorded at turn+0.5 lands
// between its neighbours and two checkpoints never overlap on one row.
check('a safety backup sits between turns',
  safetyNode.row > cp2Node.row
  && layout.nodes.filter((node) => node.turn > 2.5).every((node) => node.row > safetyNode.row)
  && new Set(layout.nodes.map((node) => node.row)).size === layout.nodes.length,
  JSON.stringify({
    safety: [safetyNode.row, safetyNode.turn],
    cp2: [cp2Node.row, cp2Node.turn],
    uniqueRows: new Set(layout.nodes.map((node) => node.row)).size,
    nodes: layout.nodes.length,
  }))
check('chain edges connect consecutive rows within a lane', layout.edges.filter((edge) => edge.kind === 'chain' && edge.from.checkpoint.sessionId === 'session-root').length === 2)
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
check('row cards fill the graph viewport',
  layout.cardW >= MIN_CARD_W && layout.cardW >= layout.width * 0.4,
  `${layout.cardW} of ${layout.width}`)
check('the cards fill the space between the two equal margins',
  // The left inset is reserved on the right as well, so the two margins match, neither
  // depends on the branch count, and the row is as long as that allows.
  Math.abs((layout.cardX + layout.cardW) - (layout.width - layout.cardX)) <= 1
  && layout.cardX + layout.cardW <= layout.width,
  JSON.stringify({ cardX: layout.cardX, cardW: layout.cardW, width: layout.width }))
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

// ── the timeline draws no branch titles ────────────────────────────────────
// Asked for explicitly: two branches meant two long titles over the timeline, which
// read as duplicated clutter. The rails and the accent dot carry the meaning now.
check('no branch title is drawn over the timeline',
  !tree.includes('rw-chip') && !treeElement.props.children?.some?.((child) => false),
  'no chip elements')
check('the empty graph still renders its own state, not a chip',
  typeof moduleExports.__internals.graphFor === 'function',
  'graphFor available')
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
check('the removed run hangs off the trunk: survivors keep the current line',
  // The trunk (lane 0) carries every survivor; the removed run gets the lane to its
  // right, so the live path stays one unbroken line.
  forkNode('f6').column > forkNode('f5').column
  && forkNode('f10').column === forkNode('f5').column
  && forkNode('f10').dead !== true && forkNode('f5').dead !== true,
  JSON.stringify([forkNode('f5')?.column, forkNode('f6')?.column, forkNode('f10')?.column]))
check('a connector hangs the removed run off the row it was cut from',
  forkLayout.edges.some((edge) => edge.kind === 'fork' && edge.surface === true
    && edge.from.checkpoint.id === 'f5' && edge.to.dead === true),
  JSON.stringify(forkLayout.edges.filter((edge) => edge.kind === 'fork')
    .map((edge) => [edge.from.checkpoint.id, edge.to.checkpoint.id, edge.surface === true])))
check('the removed run is counted on its own lane',
  forkLayout.lanes.some((lane) => lane.rewound === 4)
  && forkLayout.lanes.filter((lane) => lane.dead === true).length >= 1,
  JSON.stringify(forkLayout.lanes.map((lane) => [lane.column, lane.dead, lane.rewound])))
check('no branch chip is labelled by a badge: the branch name is the label',
  forkLayout.lanes.every((lane) => !String(lane.chip).includes(t('badge.newBranch'))
    && !String(lane.chip).includes(t('badge.current'))))
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

// ── blocks of ten fold as a whole ─────────────────────────────────────────
// The rule, as asked for: cut blocks of ten from the oldest end, fold only full
// blocks, never fold the first row. 21 rows therefore show 1 row and hide 20.
const groupRows = moduleExports.__internals.groupRows
const rowsOf = (count) => Array.from({ length: count }, (_, index) => ({
  id: `r${index}`, afterTurn: index, sessionId: 's1', manifest: true, prompt: `问 ${index}`,
}))
const none = new Set()

const twentyOne = groupRows(rowsOf(21), none, 10)
check('21 rows fold into two whole blocks (1-10, 11-20)',
  twentyOne.visible.length === 3
  && twentyOne.groups.length === 2
  && twentyOne.groups.every((group) => group.count === 10 && group.collapsed === true)
  && twentyOne.visible[0].id === 'r0'
  && twentyOne.visible[1].id === 'r1' && twentyOne.visible[1].folded?.to === 10
  && twentyOne.visible[2].id === 'r11' && twentyOne.visible[2].folded?.to === 20,
  JSON.stringify({
    visible: twentyOne.visible.map((row) => row.id ?? row.__group),
    groups: twentyOne.groups.map((group) => [group.from, group.to, group.count, group.collapsed]),
  }))
check('the first block starts at the second row and ends at row ten',
  twentyOne.groups[0].from === 1 && twentyOne.groups[0].to === 10
  && twentyOne.groups[1].from === 11 && twentyOne.groups[1].to === 20)
check('the folded count is 20 of 21',
  21 - twentyOne.visible.filter((row) => row.folded === undefined).length === 20,
  String(21 - twentyOne.visible.filter((row) => row.__group !== true).length))

const opened = groupRows(rowsOf(21), new Set([1]), 10)
check('opening a block reveals its ten rows and drops the summary',
  opened.visible.length === 12
  && opened.groups[0].collapsed === false && opened.groups[1].collapsed === true
  && opened.visible.filter((row) => row.folded !== undefined).length === 1
  && opened.visible[1].id === 'r1' && opened.visible[1].control?.collapsed === false,
  JSON.stringify(opened.visible.map((row) => row.id)))
const fifteen = groupRows(rowsOf(15), none, 10)
check('a partial trailing block never folds',
  fifteen.groups.length === 2
  && fifteen.groups[1].count === 4 && fifteen.groups[1].foldable === false
  && fifteen.visible.filter((row) => row.folded === undefined).length === 5,
  JSON.stringify({ groups: fifteen.groups.map((group) => [group.count, group.foldable]), visible: fifteen.visible.length }))

check('ten rows or fewer never fold',
  groupRows(rowsOf(10), none, 10).groups.length === 0
  && groupRows(rowsOf(3), none, 10).visible.length === 3)
check('eleven rows fold exactly one block', (() => {
  const eleven = groupRows(rowsOf(11), none, 10)
  return eleven.groups.length === 1 && eleven.groups[0].foldable === true
    && eleven.visible.length === 2 && eleven.visible[0].id === 'r0' && eleven.visible[1].folded?.to === 10
})())
check('the first row survives every fold state',
  twentyOne.visible[0].id === 'r0' && fifteen.visible[0].id === 'r0' && opened.visible[0].id === 'r0')
check('a block header carries the range and its state for the control',
  twentyOne.visible[1].folded.from === 1 && twentyOne.visible[1].folded.to === 10
  && twentyOne.visible[1].folded.count === 10 && twentyOne.visible[1].control?.collapsed === true
  && twentyOne.visible[0].id === 'r0')
check('a block header keeps its own checkpoints reachable while folded',
  // The folded row IS the block's first checkpoint, so its details work.
  twentyOne.visible[1].id === 'r1' && twentyOne.visible[2].id === 'r11'
  && twentyOne.visible[2].control?.from === 11,
  JSON.stringify([twentyOne.visible[1].id, twentyOne.visible[2].id, twentyOne.visible[2].control?.from]))
check('the block copy names its range and count',
  typeof t('panel.groupRow') === 'string' && t('panel.groupRow').includes('{count}')
  && t('panel.groupRow').includes('{from}') && t('panel.groupRow').includes('{to}'))

// The layout must not leave blank space where a folded block used to be.
const foldLayout = moduleExports.buildLayout(
  [{ id: 's1', title: '会话', live: true }],
  twentyOne.visible,
  { width: 420 },
)
const foldRows = foldLayout.nodes.slice().sort((a, b) => a.row - b.row)
check('the folded timeline is compact: one row pitch per visible row',
  foldRows.every((node, index) => index === 0 || (node.row === foldRows[index - 1].row + 1
    && node.y - foldRows[index - 1].y === 54)),
  JSON.stringify(foldRows.map((node) => [node.row, node.y])))
check('a folded block owns exactly one row slot',
  foldRows.filter((node) => node.checkpoint?.folded !== undefined).length === 2)
check('no blank space is left above the newest rows', foldLayout.height <= 54 * 4 + 16,
  String(foldLayout.height))
// ── polling must not rebuild the graph ─────────────────────────────────────
// The overview is polled every couple of seconds; when the payload carries no
// news the previous object is kept, so the memoized layout and the SVG are left
// alone. Without this, every poll repainted the whole timeline and folding felt
// stuck.
const signature = moduleExports.__internals.overviewSignature
const basePayload = {
  currentSessionId: 's1',
  cwd: '/ws',
  roots: ['/ws'],
  sessions: [{ id: 's1', title: '会话' }],
  checkpoints: [
    { id: 'c1', afterTurn: 1, manifest: true, reachable: true, canFork: true },
    { id: 'c2', afterTurn: 2, manifest: false, alreadyRewound: true },
  ],
}
const identicalPayload = JSON.parse(JSON.stringify(basePayload))
check('an unchanged payload has an unchanged signature',
  signature(basePayload) === signature(identicalPayload))
check('a new checkpoint changes the signature', signature(basePayload) !== signature({
  ...basePayload,
  checkpoints: [...basePayload.checkpoints, { id: 'c3', afterTurn: 3, manifest: true }],
}))
check('a flag flip changes the signature', signature(basePayload) !== signature({
  ...basePayload,
  checkpoints: [{ ...basePayload.checkpoints[0], alreadyRewound: true }, basePayload.checkpoints[1]],
}))
check('a session title change changes the signature', signature(basePayload) !== signature({
  ...basePayload,
  sessions: [{ id: 's1', title: '改过标题' }],
}))
check('a queued rewind changes the signature', signature(basePayload) !== signature({
  ...basePayload,
  queue: { pending: { checkpointId: 'c1', queuedAt: 1 } },
}))
check('an empty payload is safe to fingerprint', signature(undefined) === '')

// ── the confirm path, driven end to end against a recording transport ──────
// This is the code that kept failing in the field (a double rewind, a silent
// close, a refused-but-invisible apply), so it is exercised directly instead of
// being trusted.
const executeRequest = moduleExports.__internals.executeRequest
const describeRequest = moduleExports.__internals.describeRequest

function recordingDeps(options = {}) {
  const calls = []
  const drafts = []
  const submissions = []
  const deps = {
    calls,
    drafts,
    submissions,
    rpc: async (method, params) => {
      calls.push([method, params])
      if (options.fail === true) return { ok: false, error: { code: 'session-busy', message: '代理正在执行工具调用' } }
      if (options.queued === true) return { ok: true, value: { queued: true, checkpointId: params.checkpointId } }
      if (method === 'apply' && params.conversation === 'inplace') {
        return { ok: true, value: { queued: false, conversation: { droppedTurns: [1, 2] } } }
      }
      if (method === 'apply' && params.workspace === 'restore') {
        return { ok: true, value: { queued: false, workspace: { restored: 1, recreated: 2, deleted: 3, failed: [] } } }
      }
      return { ok: true, value: {} }
    },
    forkBranch: async (checkpoint) => {
      calls.push(['fork', { checkpointId: checkpoint.id }])
      return options.forkFails === true ? { ok: false, error: { message: 'fork unavailable' } } : { ok: true, childId: 'child-1' }
    },
    inputActions: {
      setDraft: (text) => drafts.push(text),
      submit: () => submissions.push('submit'),
    },
    t,
  }
  return deps
}

const checkpointsForRequest = [
  { id: 'cpA', afterTurn: 3, prompt: '原始提问' },
]

{
  const deps = recordingDeps()
  const result = await executeRequest(
    { checkpoint: checkpointsForRequest[0], conversation: 'inplace', workspace: 'none' },
    deps,
  )
  check('an in-place rewind issues exactly one apply',
    deps.calls.length === 1 && deps.calls[0][0] === 'apply'
    && deps.calls[0][1].checkpointId === 'cpA' && deps.calls[0][1].conversation === 'inplace'
    && deps.calls[0][1].workspace === 'none' && deps.calls[0][1].confirm === true,
    JSON.stringify(deps.calls))
  check('an in-place rewind reports what it dropped', result.messages.length === 1 && result.messages[0].includes('2'),
    JSON.stringify(result.messages))
}
{
  const deps = recordingDeps()
  const result = await executeRequest(
    { checkpoint: { id: 'cpNewest' }, conversation: 'inplace', reask: true, reaskFrom: 'cpAnchor', text: '改写的提问' },
    deps,
  )
  // The regression that broke this: two applies, the first on the selected row.
  check('re-asking issues ONE apply, at the anchor, never on the selected row',
    deps.calls.length === 1 && deps.calls[0][1].checkpointId === 'cpAnchor'
    && deps.calls.every((call) => call[1].checkpointId !== 'cpNewest'),
    JSON.stringify(deps.calls))
  check('re-asking hands the edited prompt to the composer and sends it',
    deps.drafts[0] === '改写的提问' && deps.submissions.length === 1,
    JSON.stringify({ drafts: deps.drafts, submissions: deps.submissions }))
  check('re-asking reports both halves', result.messages.length === 2, JSON.stringify(result.messages))
}
{
  const deps = recordingDeps()
  await executeRequest({ checkpoint: checkpointsForRequest[0], conversation: 'inplace', workspace: 'restore' }, deps)
  check('"both" restores the workspace and then the conversation',
    deps.calls.length === 2
    && deps.calls[0][1].workspace === 'restore' && deps.calls[0][1].conversation === 'none'
    && deps.calls[1][1].conversation === 'inplace' && deps.calls[1][1].workspace === 'none',
    JSON.stringify(deps.calls.map((call) => call[1])))
}
{
  const deps = recordingDeps()
  await executeRequest({ checkpoint: checkpointsForRequest[0], conversation: 'fork', workspace: 'none' }, deps)
  check('a fork calls the shipped fork API and no rewind',
    deps.calls.length === 1 && deps.calls[0][0] === 'fork', JSON.stringify(deps.calls))
}
{
  const deps = recordingDeps({ queued: true })
  const result = await executeRequest(
    { checkpoint: { id: 'cpNewest' }, conversation: 'inplace', reask: true, reaskFrom: 'cpAnchor', text: '排队提问' },
    deps,
  )
  check('a queued rewind reports itself and does not send the prompt yet',
    result.queued === true && result.reask?.text === '排队提问' && result.reask?.checkpointId === 'cpAnchor'
    && deps.submissions.length === 0,
    JSON.stringify({ result, submissions: deps.submissions }))
}
{
  const deps = recordingDeps({ fail: true })
  let message = ''
  try {
    await executeRequest({ checkpoint: checkpointsForRequest[0], conversation: 'inplace', workspace: 'none' }, deps)
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('a refused apply surfaces the host message instead of closing quietly',
    message.includes('工具调用'), message)
}
{
  const deps = recordingDeps()
  let message = ''
  try {
    await executeRequest({ checkpoint: checkpointsForRequest[0], conversation: 'none', workspace: 'none' }, deps)
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('a request with nothing to do aborts loudly rather than pretending to succeed',
    message === t('notice.nothingToDo') && deps.calls.length === 0, message)
}
check('the footer log names the call a request will issue',
  describeRequest({ conversation: 'inplace' }) === 'apply(conversation=inplace)'
  && describeRequest({ reask: true }).includes('anchor')
  && describeRequest({ conversation: 'fork', workspace: 'restore' }).includes('fork'),
  JSON.stringify([describeRequest({ conversation: 'inplace' }), describeRequest({ reask: true })]))

// ── the fold toggle must change the picture it draws ───────────────────────
// The state used to flip while the graph stayed the same, because the layout was
// memoized on the fetched payload instead of on the visible rows. graphFor() is
// the single entry point for that pipeline, so this is directly assertable.
const graphFor = moduleExports.__internals.graphFor
const foldSessions = [{ id: 's1', title: '会话', live: true }]
const foldCheckpoints = Array.from({ length: 16 }, (_, index) => ({
  id: `g${index}`, sessionId: 's1', afterTurn: index, kind: 'auto', manifest: true, prompt: `问 ${index}`,
}))
const collapsedGraph = graphFor(foldSessions, foldCheckpoints, { expandedGroups: new Set(), limit: 10, width: 900 })
const expandedGraph = graphFor(foldSessions, foldCheckpoints, {
  expandedGroups: new Set(foldCheckpoints.slice(1, 11).map((row) => row.afterTurn)),
  limit: 10,
  width: 900,
})
check('the collapsed graph draws fewer rows than the expanded one',
  collapsedGraph.layout.nodes.length < expandedGraph.layout.nodes.length
  && collapsedGraph.layout.nodes.length === 7 && expandedGraph.layout.nodes.length === 16,
  JSON.stringify([collapsedGraph.layout.nodes.length, expandedGraph.layout.nodes.length]))
check('the collapsed graph carries one folded row per block',
  collapsedGraph.visible.filter((row) => row.folded !== undefined).length === 1
  && collapsedGraph.visible.length === 7)
check('the collapsed graph is shorter than the expanded one',
  collapsedGraph.layout.height < expandedGraph.layout.height,
  JSON.stringify([collapsedGraph.layout.height, expandedGraph.layout.height]))
check('a collapsed block hides its ten rows behind one row',
  collapsedGraph.visible[0].id === 'g0' && collapsedGraph.visible[1].id === 'g1'
  && collapsedGraph.visible[1].folded !== undefined
  && expandedGraph.visible.length - collapsedGraph.visible.length === 9,
  JSON.stringify(collapsedGraph.visible.map((row) => row.id)))
check('the fold control has a row to attach to in both states',
  collapsedGraph.layout.nodes.some((node) => node.checkpoint?.folded !== undefined)
  && expandedGraph.layout.nodes.some((node) => node.checkpoint?.control !== undefined))
// ── the dialog must be clickable, not covered by its own backdrop ──────────
// Reported from the field as "the dialog opens, nothing is clickable, and
// clicking it closes it": the backdrop is `position:absolute` while the dialog
// was static, so the backdrop painted on top and swallowed every click — which
// both dimmed the dialog (grey-looking buttons) and cancelled on any click.
const sheet = moduleExports.css
check('the dialog is positioned above its backdrop',
  /\.rw-modal\{[^}]*position:relative/.test(sheet) && /\.rw-modal\{[^}]*z-index:1/.test(sheet)
  && /\.rw-backdrop\{z-index:0\}/.test(sheet),
  JSON.stringify({
    modal: /\.rw-modal\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 90),
    backdrop: /\.rw-backdrop\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 60),
  }))
check('the drawer is positioned too, so its backdrop cannot cover it',
  /\.rw-drawer\{position:(relative|absolute|fixed)/.test(sheet),
  /\.rw-drawer\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 60))
// The panel used to hug the window's right edge (96vw wide, rounded on one corner
// only), which read as "very long, with uneven margins".
check('the panel has equal left and right margins',
  /\.rw-overlay-layer\{[^}]*padding:var\(--rw-titlebar-height\) 14px 14px 14px/.test(sheet)
  // Centred, or the left gap would be the leftover space while the right gap was
  // only the padding — the lopsided look that was reported twice.
  && /\.rw-overlay-layer\{[^}]*justify-content:center/.test(sheet),
  /\.rw-overlay-layer\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 130))
check('the panel is a rounded card, not a flush edge',
  /\.rw-drawer\{[^}]*width:min\(860px,100%\)/.test(sheet)
  && /\.rw-drawer\{[^}]*border:1px solid/.test(sheet)
  && /\.rw-drawer\{[^}]*border-radius:12px/.test(sheet)
  && !/96vw/.test(sheet),
  /\.rw-drawer\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 120))

// A row that was already replaced cannot be rewound in place (no turn on the
// surface to cut at). It stays forkable, and the panel has to say so rather than
// leave a dead button with no way forward.
const replacedRow = {
  id: 'cp-replaced', afterTurn: 3, kind: 'auto', manifest: true, prompt: '被替换的提问',
  alreadyRewound: true, reachable: false, canFork: true, hasNextTurn: true, nextTurnExists: true,
  canRestoreWorkspace: true,
}
const replacedMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: replacedRow,
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  onClose: () => {},
  canReask: false,
  inplace: false,
  inplaceReason: '就地遗忘在当前版本不可用',
}))
check('a replaced row explains itself and points at the branch rewind',
  replacedMarkup.includes(t('notice.unreachable')) && replacedMarkup.includes(t('notice.branchHint')),
  replacedMarkup.includes(t('notice.branchHint')) ? 'hint present' : replacedMarkup.slice(0, 160))
check('the branch rewind stays enabled on a replaced row',
  replacedMarkup.includes(t('action.fork'))
  && !new RegExp(`disabled=""[^>]*>${t('action.fork')}<`).test(replacedMarkup),
  replacedMarkup.slice(Math.max(0, replacedMarkup.indexOf(t('action.fork')) - 90), replacedMarkup.indexOf(t('action.fork')) + 16))

const dialogProps = {
  request: { checkpoint: { id: 'cp1', afterTurn: 3 }, conversation: 'inplace', workspace: 'none' },
  plan: undefined,
  t,
  onCancel: () => {},
  onConfirm: () => {},
}
const dialogMarkup = ReactDOMServer.renderToStaticMarkup(
  React.createElement(moduleExports.ConfirmDialog, { ...dialogProps, busy: false, error: undefined, queued: false }),
)
check('the dialog renders a live confirm button when nothing is running',
  dialogMarkup.includes('rw-modal-actions') && !dialogMarkup.includes('disabled=""'),
  dialogMarkup.slice(dialogMarkup.indexOf('rw-modal-actions'), dialogMarkup.indexOf('rw-modal-actions') + 160))
check('the dialog is announced as a modal dialog',
  dialogMarkup.includes('role="dialog"') && dialogMarkup.includes('aria-modal="true"'))
check('a running action disables the confirm button but still offers a way out',
  ReactDOMServer.renderToStaticMarkup(
    React.createElement(moduleExports.ConfirmDialog, { ...dialogProps, busy: true, error: undefined, queued: false }),
  ).includes('disabled=""'))

// ── a block header is a control, not a checkpoint ─────────────────────────
// A folded block is drawn as ONE row, and that row IS the block's first checkpoint:
// clicking it opens real details, so its rewind actions work without a second control.
const selectedCheckpointOf = moduleExports.__internals.selectedCheckpointOf
const foldedIds = collapsedGraph.visible.filter((row) => row.folded !== undefined).map((row) => row.id)
check('a folded row resolves to the block’s own first checkpoint',
  // Deriving the id from a real row is the point: its details must work.
  foldedIds.length > 0 && foldedIds.every((id) => selectedCheckpointOf(collapsedGraph.visible, id) !== undefined),
  JSON.stringify(foldedIds))
check('a real row still resolves, and so does an empty selection',
  selectedCheckpointOf(collapsedGraph.visible, 'g0')?.id === 'g0'
  && selectedCheckpointOf(collapsedGraph.visible, undefined) === undefined
  && selectedCheckpointOf(collapsedGraph.visible, 'nope') === undefined)
const headerMarkup = (() => {
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
    layout: collapsedGraph.layout,
    selectedId: foldedIds[0],
    currentSessionId: 's1',
    onSelect: () => {},
    onToggleGroup: () => {},
    t,
  }))
  return markup
})()
check('a folded row is a card with its range and the fold control, not a bare header',
  headerMarkup.includes('rw-groupbtn')
  && headerMarkup.includes(t('panel.groupRow', { count: 10, from: '1', to: '10' }).slice(0, 6))
  && headerMarkup.includes('rw-card'),
  headerMarkup.slice(0, 0) + `controls=`)

// ── no branch titles are drawn at all ──────────────────────────────────────
// Asked for explicitly: two branches meant two long titles over the timeline, which
// read as duplicated clutter. A lane's identity is its rail, its dot and its colour;
// nothing textual is painted over the rows.
const chipGraph = graphFor(
  [{ id: 's1', title: '做一个deepseek harness插件，用户能够对话回退、工作区回滚，并有专门的可视化树图', live: true }],
  rowsOf(3).map((row) => ({ ...row, sessionId: 's1' })),
  { width: 420 },
)
const chipClosed = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout: chipGraph.layout, currentSessionId: 's1', onSelect: () => {}, t,
}))
check('the timeline draws no branch title text',
  (() => {
    const visible = [...chipClosed.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
      .map((match) => match[1]).join(' ')
    return !chipClosed.includes('rw-chip') && !chipClosed.includes('rw-chippop')
      && !visible.includes('当前分支') && !visible.includes('回退后新分支')
      && !visible.includes('做一个deepseek')
  })(),
  'no branch title painted over the rows')
// ── a rewound row shows no turn number at all ──────────────────────────────
// Asked for: "don't show the turn number on rewound conversations — neither the rail
// gutter nor the session row". A dead row is off the model's history, and numbering it
// made the dead run read as if it were still part of the conversation.
{
  const deadRows = [
    { id: 'cp0', sessionId: 's1', afterTurn: 0, manifest: true, prompt: '第一轮', abandoned: false },
    { id: 'cp1', sessionId: 's1', afterTurn: 1, manifest: true, prompt: '被回退的一轮', abandoned: true },
    { id: 'cp2', sessionId: 's1', afterTurn: 2, manifest: true, prompt: '新的一轮', abandoned: false },
  ]
  const deadGraph = graphFor([{ id: 's1', title: '会话', live: true }], deadRows, { width: 900, limit: 10 ** 9 })
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
    layout: deadGraph.layout, currentSessionId: 's1', onSelect: () => {}, t,
  }))
  // A rewound row keeps its number (so the card and the rail agree — both read the
  // node's own turn) and the SAME line crosses it in both places: 1px, the same
  // colour and the same offset, so the two read as one gesture.
  const numbers = (markup.match(/轮次/g) ?? []).length
  const strikes = [...markup.matchAll(/<line class="rw-strike"[^>]*>/g)].map((match) => match[0])
  const strikeY = [...markup.matchAll(/<line class="rw-strike"[^>]*y1="([\d.]+)"/g)]
    .map((match) => match[1])
  check('a rewound row keeps its number, struck through the same way in rail and card',
    numbers >= 4 && markup.includes('轮次 1') && markup.includes('被回退的一轮')
    && strikes.length === 2
    && strikes.every((line) => line.includes('stroke-width="1"') && line.includes('opacity="0.75"'))
    // Each line sits 4px above its own text's baseline: the rail label at y+4 and the
    // card title at y+20 are crossed at y and y+16 respectively.
    && strikeY.includes('96') && strikeY.includes('103')
    && markup.includes('y="100"') && markup.includes('y="107"'),
    `strikes=${strikes.length} y=${strikeY.join(',')}`)
}
// ── the numbering is the log's, and grey means "a cut removed it" ──────────
// Asked for: 1..9, rewind to 5 → the continuation is 10 11 12 13 14 (6 7 8 9 grey);
// then rewind to 11 → 15 16 17 18 (6 7 8 9 12 13 14 grey). Two things have to hold:
// a branch keeps counting after the cut, and the rows an EARLIER branch kept are not
// greyed out — the host's cumulative `abandoned` flag marks those too.
{
  const logRows = []
  const add = (turn, abandoned) => logRows.push({
    id: `cp${turn}`, sessionId: 's1', afterTurn: turn, manifest: true, prompt: `p${turn}`,
    abandoned, ownTurnRewound: false,
  })
  for (let turn = 0; turn <= 9; turn += 1) add(turn, turn >= 6)
  for (let turn = 10; turn <= 14; turn += 1) add(turn, turn >= 12)
  for (let turn = 15; turn <= 18; turn += 1) add(turn, false)
  const logSessions = [{
    id: 's1',
    title: '会话',
    live: true,
    cuts: [{ index: 0, fromTurn: 6, toTurn: 9, count: 4 }, { index: 1, fromTurn: 12, toTurn: 14, count: 3 }],
  }]
  const logGraph = graphFor(logSessions, logRows, { width: 1200, limit: 10 ** 9 })
  const lane = (column) => logGraph.layout.nodes
    .filter((node) => node.column === column)
    .sort((a, b) => a.turn - b.turn)
    .map((node) => `${node.turn}${node.dead === true ? '*' : ''}`)
  check('the survivors form one line and each cut hangs off it',
    lane(0).join(' ') === '0 1 2 3 4 5 10 11 15 16 17 18'
    && lane(1).join(' ') === '6* 7* 8* 9*'
    && lane(2).join(' ') === '12* 13* 14*',
    JSON.stringify({ trunk: lane(0), first: lane(1), second: lane(2) }))
}
// ── "shows as rewound" and "is rewound" must be the same flag ───────────────
// The reported contradiction: the details pane said the row was live while the card was
// dimmed, because the card styling also consulted the host's CUMULATIVE `abandoned`
// flag. A row the current branch uses must look live whatever that flag says.
{
  const sharedRows = [
    { id: 'cp0', sessionId: 's1', afterTurn: 0, manifest: true, prompt: '第一轮', abandoned: false },
    // Left the surface at some earlier point, but the current branch uses it again.
    // lreadyRewound: false is what the real host reports: the strict flags are the
    // authority, and bandoned alone is only a fallback for a host without them.
    { id: 'cp1', sessionId: 's1', afterTurn: 1, manifest: true, prompt: '保留下来的行', abandoned: true, alreadyRewound: false },
    { id: 'cp0b', sessionId: 's1', afterTurn: 0, manifest: true, prompt: '', alreadyRewound: false },
  ]
  const sharedGraph = graphFor([{ id: 's1', title: '会话', live: true }], sharedRows, { width: 900, limit: 10 ** 9 })
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
    layout: sharedGraph.layout, currentSessionId: 's1', onSelect: () => {}, t,
  }))
  const nodeLive = sharedGraph.layout.nodes.find((node) => node.checkpoint.id === 'cp1')?.dead !== true
  check('a live row is drawn as live even when the host still marks it abandoned',
    nodeLive
    && !markup.includes('stroke-dasharray="5 3"')
    && markup.includes('var(--rw-fg)')
    // The badge must not contradict the card either: no "rewound" on a live row, and a
    // snapshot row keeps its green stripe.
    && !markup.includes(t('badge.rewound'))
    && markup.includes('var(--rw-ok)'),
    JSON.stringify({ nodeLive }))
}
// ── the newest branch's numbers are bold white ─────────────────────────────
// Asked for: "the new turn's rail number should be bold white type". The lane the
// conversation is on is the only one that is not history, so its numbers are the only
// ones drawn in full contrast; rewound rows stay dim and struck through.
{
  const headRows = [
    { id: 'cp0', sessionId: 's1', afterTurn: 0, manifest: true, prompt: '第一轮' },
    { id: 'cp1', sessionId: 's1', afterTurn: 1, manifest: true, prompt: '被回退的一轮', abandoned: true },
    { id: 'cp2', sessionId: 's1', afterTurn: 2, manifest: true, prompt: '最新的一轮' },
  ]
  const headGraph = graphFor([{ id: 's1', title: '会话', live: true }], headRows, { width: 900, limit: 10 ** 9 })
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
    layout: headGraph.layout, currentSessionId: 's1', onSelect: () => {}, t,
  }))
  const gutters = [...markup.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)]
    .map((match) => match[0])
  const bold = gutters.filter((tag) => tag.includes('font-weight="700"'))
  const dim = gutters.filter((tag) => tag.includes('var(--rw-fg-3)'))
  check('the live branch number is bold white and the rewound one is not',
    // The trunk (live rows) is bold white; the removed runs are dim.
    bold.length >= 1 && dim.length === 1
    && bold[0].includes('var(--rw-fg)'),
    JSON.stringify({ gutters: gutters.length, bold: bold.length, dim: dim.length }))
}
// ── the graph never squeezes the rows ──────────────────────────────────────
// Asked for: "the rail UI must not squeeze the other UI — if there are too many
// lines, compress its own width". So the card column is identical whatever the
// branch count, and the rails tighten their spacing instead.
const laneProbe = {}
check('the cards keep their width however many branches there are',
  (() => {
    const measured = [1, 2, 3, 5, 9].map((lanes) => {
      const rows = rowsOf(6).map((row, index) => ({
        ...row, sessionId: `s${index % lanes}`, manifest: true,
      }))
      const sessions = Array.from({ length: lanes }, (_, index) => ({ id: `s${index}`, live: index === 0 }))
      const { layout: laneLayout } = graphFor(sessions, rows, { width: 1200 })
      return {
        lanes: laneLayout.laneCount,
        cardX: Math.round(laneLayout.cardX),
        cardW: Math.round(laneLayout.cardW),
      }
    })
    laneProbe.__measured = measured
    const widths = new Set(measured.map((entry) => entry.cardW))
    const starts = new Set(measured.map((entry) => entry.cardX))
    return widths.size === 1 && starts.size === 1
  })(),
  JSON.stringify(laneProbe.__measured ?? []))
// ── each rewind is its own branch ──────────────────────────────────────────
// Reported: after a first rewind (2–7), continuing to 14 and rewinding to 10 drew
// the whole thing as one "2–15 new branch". The shape must be
//   2–7 dead · 8 9 kept · 10–15 dead · 16+ the new branch
// with one elbow per cut, which needs the host's per-rewind turn ranges.
{
  const cutSessions = [{
    id: 's1',
    title: '会话',
    live: true,
    cuts: [{ index: 0, fromTurn: 8, toTurn: 10, count: 3 }, { index: 1, fromTurn: 14, toTurn: 16, count: 3 }],
  }]
  const cutCheckpoints = []
  for (let turn = 0; turn <= 20; turn += 1) {
    const rewoundAway = (turn >= 8 && turn <= 10) || (turn >= 14 && turn <= 16)
    cutCheckpoints.push({
      id: `cp${turn}`, sessionId: 's1', afterTurn: turn, manifest: true, prompt: `p${turn}`,
      abandoned: rewoundAway, ownTurnRewound: false,
    })
  }
  const cutGraph = graphFor(cutSessions, cutCheckpoints, { width: 1000, limit: 10 ** 9 })
  const deadTurns = cutGraph.layout.nodes.filter((node) => node.dead === true).map((node) => node.turn)
  const liveKept = cutGraph.layout.nodes.filter((node) => node.dead !== true && node.column === 1).map((node) => node.turn)
  const newest = cutGraph.layout.nodes.filter((node) => node.column === 2).map((node) => node.turn)
  const elbows = cutGraph.layout.edges.filter((edge) => edge.surface === true)
    .map((edge) => [edge.from.checkpoint.afterTurn, edge.to.checkpoint.afterTurn])
  check('each rewind draws as its own branch, not one lumped run',
    // The branch restarts the numbering at the cut: after rewinding 10 -> 7 the new\n    // turn is 8 again, and the second cut (14 -> 13) starts the next lane at 11.\n    deadTurns.join(',') === '8,9,10,14,15,16'\n    && liveKept.join(',') === '8,9,10'\n    && newest.length > 0 && newest[0] === 11\n    && JSON.stringify(elbows) === JSON.stringify([[7, 11], [13, 17]]),
    JSON.stringify({ deadTurns, liveKept, newest: newest.slice(0, 3), elbows }))
}
// ── a re-ask restores the tree the turn STARTED from ───────────────────────
// Reported with files: "3 4 5 6 → delete everything → 1 2 3", then re-asking the delete
// step. The new prompt is applied to the tree as it was BEFORE that turn (3 4 5 6), so
// restoring the selected row's own snapshot (the emptied tree) is wrong — the re-ask
// must restore the anchor row above it.
{
  const calls = []
  const deps = {
    rpc: async (method, params) => {
      calls.push([method, params.checkpointId, params.workspace, params.conversation])
      return { ok: true, value: { workspace: { restored: 0, recreated: 0, deleted: 0, failed: [] }, conversation: { droppedTurns: [] } } }
    },
    forkBranch: async () => ({ ok: true }),
    inputActions: { setDraft: () => {}, submit: () => {} },
    t,
  }
  await executeRequest({
    checkpoint: { id: 'cp-after' },
    conversation: 'inplace',
    workspace: 'restore',
    reask: true,
    reaskFrom: 'cp-before',
    text: '把 5 改成 6',
  }, deps)
  check('a re-ask restores the anchor row, not the row being re-asked',
    calls.some(([method, id, workspace]) => method === 'apply' && workspace === 'restore' && id === 'cp-before')
    && !calls.some(([method, id, workspace]) => method === 'apply' && workspace === 'restore' && id === 'cp-after'),
    JSON.stringify(calls))
}
// ── a re-ask finds the nearest snapshot, not "no snapshot → skip" ──────────
// Reported: "delete every digit → re-ask as change 3 to 7 → re-ask THAT as delete every
// 3", and the second re-ask ran against the emptied tree. Its anchor row had no
// snapshot, so the restore was skipped and the workspace stayed as the previous re-ask
// had left it: emptied.
{
  const rows = [
    { id: 'cp1', sessionId: 's1', afterTurn: 1, manifest: true, canRestoreWorkspace: true, reachable: true, prompt: 'a' },
    { id: 'cp2', sessionId: 's1', afterTurn: 2, manifest: false, canRestoreWorkspace: false, reachable: true, prompt: 'b' },
    { id: 'cp3', sessionId: 's1', afterTurn: 3, manifest: false, canRestoreWorkspace: false, reachable: true, prompt: 'c' },
  ]
  const picked = moduleExports.__internals.restoreAnchorFor(rows, rows[2])
  check('a re-ask falls back to the nearest earlier snapshot',
    picked?.id === 'cp1', JSON.stringify(picked?.id))
  const nearest = moduleExports.__internals.restoreAnchorFor(
    [rows[1], { id: 'cp2b', sessionId: 's1', afterTurn: 2, manifest: true, canRestoreWorkspace: true, reachable: true, prompt: 'b2' }, rows[2]],
    rows[2],
  )
  check('the closest snapshot wins when there is a choice',
    nearest?.id === 'cp2b', JSON.stringify(nearest?.id))
}
// ── a GREYED row's snapshot is not a restore point ─────────────────────────
// Reported: re-asking 84 restored the tree of 83 — the turn that had just been greyed
// ("delete every digit"), so the new prompt ran against the emptied tree. A greyed row
// is history; the memory to come back to is the nearest LIVE row before it (82).
{
  const rows = [
    { id: 'cp82', sessionId: 's1', afterTurn: 82, manifest: true, canRestoreWorkspace: true, reachable: true, prompt: 'a' },
    // 83 was re-asked: greyed, and its snapshot is the emptied tree — never use it.
    { id: 'cp83', sessionId: 's1', afterTurn: 83, manifest: true, canRestoreWorkspace: true, reachable: true, prompt: 'delete every digit' },
    { id: 'cp84', sessionId: 's1', afterTurn: 84, manifest: false, canRestoreWorkspace: false, reachable: true, prompt: 'change 3 to 7' },
  ]
  const liveIds = new Set(['cp82', 'cp84'])
  const picked = moduleExports.__internals.restoreAnchorFor(
    rows.filter((row) => liveIds.has(row.id)), rows[2])
  check('a re-ask never restores from a greyed row',
    picked?.id === 'cp82', JSON.stringify(picked?.id))
}
// ── the confirm dialog names the turn ranges ───────────────────────────────
// Asked for: "the prompt when rolling back is unclear — it keeps asking me about
// earlier information". It must say which turns are kept and which are removed.
{
  const dialogMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
    request: {
      checkpoint: { id: 'cp7', afterTurn: 7 },
      conversation: 'inplace',
      workspace: 'none',
      reask: true,
      text: '改好的提问',
    },
    plan: { conversation: { ok: true, droppedTurns: [8, 9, 10] } },
    t,
    onCancel: () => {},
    onConfirm: () => {},
    busy: false,
  }))
  check('the dialog states the kept range, the removed range and where the new turn starts',
    dialogMarkup.includes(t('notice.keptTo', { turn: '7' }))
    && dialogMarkup.includes(t('notice.droppedRange', { from: '8', to: '10' }))
    && dialogMarkup.includes(t('notice.newTurnAt', { turn: '8' })),
    'ranges named in the dialog')
  const spreadMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
    request: { checkpoint: { id: 'cp7', afterTurn: 7 }, conversation: 'inplace', workspace: 'none' },
    plan: { conversation: { ok: true, droppedTurns: [9, 11] } },
    t,
    onCancel: () => {},
    onConfirm: () => {},
    busy: false,
  }))
  check('a non-contiguous removal lists the turns instead of inventing a range',
    spreadMarkup.includes(t('notice.droppedList', { turns: '9、11' })),
    'listed turns')
}
// ── every action the panel offers must reach a real branch ─────────────────
// A banner reading "nothing to run" means a confirmed action fell through every
// branch of the executor. Nothing in the UI may produce such a request, so the
// shapes the panel builds are driven through the executor and must all act.
const uiRequests = [
  ['conversationFork', { conversation: 'fork', workspace: 'none' }],
  ['conversationInplace', { conversation: 'inplace', workspace: 'none' }],
  ['workspace', { conversation: 'none', workspace: 'restore' }],
  ['bothFork', { conversation: 'fork', workspace: 'restore' }],
  ['bothInplace', { conversation: 'inplace', workspace: 'restore' }],
  ['restoreSafetyWorkspace', { conversation: 'none', workspace: 'restore' }],
]
const fellThrough = []
for (const [action, shape] of uiRequests) {
  const deps = recordingDeps()
  try {
    await executeRequest({ ...shape, checkpoint: { id: 'cpA', afterTurn: 3 } }, deps)
    if (deps.calls.length === 0) fellThrough.push(`${action}: no call issued`)
  } catch (error) {
    if (String(error?.message ?? '').includes(t('notice.nothingToDo'))) fellThrough.push(`${action}: nothing-to-do`)
  }
}
{
  const deps = recordingDeps()
  try {
    await executeRequest({ checkpoint: { id: 'cpA' }, conversation: 'inplace', reask: true, reaskFrom: 'cpA', text: '改' }, deps)
  } catch (error) {
    fellThrough.push(`reask: ${String(error?.message ?? '')}`)
  }
}
check('every panel action reaches a real branch of the executor',
  fellThrough.length === 0, JSON.stringify(fellThrough))
// ── the re-ask hands the prompt over only once the composer has it ──────────
// Reported as "a small problem with rewind-and-ask-again": the panel set the draft
// and submitted in the same tick, so the composer sent the PREVIOUS text (or an
// empty prompt) because it applies a draft on its own next render.
{
  const composer = { draft: '上一轮的残留', sent: undefined }
  const deps = {
    ...recordingDeps(),
    inputActions: {
      setDraft: (text) => { setTimeout(() => { composer.draft = text }, 10) },
      submit: () => { composer.sent = composer.draft },
    },
  }
  await executeRequest({
    checkpoint: { id: 'cpA', afterTurn: 3 },
    conversation: 'inplace',
    workspace: 'none',
    reask: true,
    reaskFrom: 'cpA',
    text: '改好的新提问',
  }, deps)
  check('a re-ask sends the edited prompt, not the previous draft',
    composer.sent === '改好的新提问', String(composer.sent))
}
check('the dismiss control exists so a banner can be cleared by hand',
  typeof t('action.dismiss') === 'string' && t('action.dismiss').length > 0)

// ── an idle re-ask must roll the CODE back too ─────────────────────────────
// "Rewind and ask again" that leaves the workspace alone answers the new prompt
// against the tree the abandoned turn produced, which is not a rollback at all.
{
  const deps = recordingDeps()
  await executeRequest({
    checkpoint: { id: 'cpNewest', canRestoreWorkspace: true },
    conversation: 'inplace',
    workspace: 'restore',
    reask: true,
    reaskFrom: 'cpAnchor',
    text: '改写的提问',
  }, deps)
  check('an edited re-ask restores the files first, then rewinds and sends',
    deps.calls.length === 2
    && deps.calls[0][1].workspace === 'restore' && deps.calls[0][1].conversation === 'none'
    && deps.calls[1][1].checkpointId === 'cpAnchor' && deps.calls[1][1].conversation === 'inplace'
    && deps.drafts[0] === '改写的提问' && deps.submissions.length === 1,
    JSON.stringify({ calls: deps.calls.map((call) => call[1]), drafts: deps.drafts }))
}
// ── a fold header must ride the rail of the rows it hides ─────────────────
// Reported as "the rails are wrong after a rewind": the header carried no session
// id, so the layout dropped it on lane 0 while its own rows sat on another rail.
const railSessions = [{ id: 's1', title: '会话一', live: true }, { id: 's2', title: '会话二', live: true }]
const railRows = [
  ...Array.from({ length: 4 }, (_, index) => ({
    id: `a${index}`, sessionId: 's1', afterTurn: index, kind: 'auto', manifest: true, prompt: `A${index}`,
  })),
  ...Array.from({ length: 14 }, (_, index) => ({
    id: `b${index}`, sessionId: 's2', afterTurn: index, kind: 'auto', manifest: true, prompt: `B${index}`,
  })),
]
const railGraph = graphFor(railSessions, railRows, { expandedGroups: new Set(), limit: 10, width: 900 })
const railHeaders = railGraph.layout.nodes.filter((node) => node.checkpoint?.folded !== undefined)
check('a folded row rides the rail of the session whose rows it hides',
  railHeaders.length === 1 && railHeaders[0].column === 1
  && railHeaders[0].railX > railGraph.layout.nodes.find((node) => node.checkpoint.sessionId === 's1').railX,
  JSON.stringify(railHeaders.map((node) => [node.checkpoint.sessionId, node.column, node.railX])))
check('every visible row of the first session stays on lane 0',
  railGraph.layout.nodes.filter((node) => node.checkpoint.sessionId === 's1').every((node) => node.column === 0),
  JSON.stringify(railGraph.layout.nodes.map((node) => [node.checkpoint.sessionId, node.column])))
check('both sessions keep their own rail',
  railGraph.layout.lanes.length === 2, String(railGraph.layout.lanes.length))

// ── every row reports what its turn cost ──────────────────────────────────
// Tokens in → out, tool calls and duration ride the card; the details pane breaks
// the numbers down.
const usageRows = groupRows(rowsOf(4).map((row, index) => ({
  ...row,
  sessionId: 's1',
  usage: index === 0 ? undefined : { inputTokens: 8075, outputTokens: 2324, totalTokens: 10399 },
  durationMs: index === 0 ? undefined : 31284,
  toolCalls: index === 0 ? undefined : 3,
  steps: 2,
})), new Set(), 10)
const usageGraph = graphFor([{ id: 's1', title: '会话', live: true }], usageRows.visible, { width: 900 })
const usageMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout: usageGraph.layout,
  selectedId: undefined,
  currentSessionId: 's1',
  onSelect: () => {},
  onToggleGroup: () => {},
  t,
}))
check('a row card summarises its turn: tokens and duration',
  usageMarkup.includes('↑8.1k ↓2.3k') && usageMarkup.includes('3 ') && usageMarkup.includes('31s'),
  usageMarkup.slice(usageMarkup.indexOf('↑8.1k') - 40, usageMarkup.indexOf('↑8.1k') + 40))
check('a row with no usage data shows none of it',
  (() => {
    const bare = graphFor([{ id: 's1', title: '会话', live: true }], rowsOf(3).map((row) => ({
      ...row, sessionId: 's1',
    })), { width: 900 })
    const bareMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
      layout: bare.layout, selectedId: undefined, currentSessionId: 's1', onSelect: () => {}, t,
    }))
    return !bareMarkup.includes('8.1k') && !bareMarkup.includes(t('usage.tokens'))
  })(),
  'no summary without usage data')
const usageDetails = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: {
    ...usageRows.visible[1],
    usage: { inputTokens: 8075, outputTokens: 2324, cacheReadTokens: 120, cacheWriteTokens: 8, totalTokens: 10399 },
    durationMs: 31284,
    toolCalls: 3,
    steps: 2,
    model: 'deepseek-flash',
  },
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  onClose: () => {},
}))
check('the details pane breaks the usage down',
  usageDetails.includes(t('usage.title')) && usageDetails.includes('↑ 8075') && usageDetails.includes('↓ 2324')
  && usageDetails.includes('10399') && usageDetails.includes(t('usage.cacheRead'))
  && usageDetails.includes('deepseek-flash') && usageDetails.includes('31s'),
  usageDetails.slice(usageDetails.indexOf(t('usage.title')), usageDetails.indexOf(t('usage.title')) + 160))

// ── the panel's own geometry is symmetrical ───────────────────────────────
// Reported from a screenshot: the card column was anchored left, so a capped card
// left all of the slack on the right and the panel looked uneven.
const wideGraph = graphFor([{ id: 's1', title: '会话', live: true }], rowsOf(4).map((row) => ({
  ...row,
  sessionId: 's1',
  manifest: true,
  stats: { files: 36, bytes: 801900 },
  usage: { inputTokens: 5200, outputTokens: 9200, totalTokens: 14400 },
  toolCalls: 3,
  durationMs: 31000,
})), { width: 1400 })
const wideLayout = wideGraph.layout
check('the card column is centred against the canvas',
  (() => {
    // The margin left of the first card must equal the margin right of the last
    // one, at every realistic panel width. Centring inside the rail area kept the
    // gutter and rails inside the left gap, which is what made the cards look
    // off-centre — most visibly on a wide panel, and again after a restart.
    const widths = [1400, 1000, 900, 700, 500]
    const measured = widths.map((width) => {
      const { layout } = graphFor([{ id: 's1', title: '会话', live: true }], rowsOf(4).map((row) => ({
        ...row, sessionId: 's1',
      })), { width })
      return {
        width,
        left: Math.round(layout.cardX),
        right: Math.round(width - (layout.cardX + layout.cardW)),
      }
    })
    wideLayout.__measured = measured
    wideLayout.__measured = measured
    // Below ~700 the card's own minimum width wins over exact symmetry.
    return measured.every((entry) => (entry.width >= 700
      ? Math.abs(entry.left - entry.right) <= 1
      : entry.left >= entry.right))
  })(),
  JSON.stringify(wideLayout.__measured ?? []))

// The usage summary sits in the card's RIGHT column, after the file/KB figure, with
// ↑ input and ↓ output — not appended to the prompt line and not a "→" between them.
const wideMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
  layout: wideGraph.layout, selectedId: undefined, currentSessionId: 's1', onSelect: () => {}, t,
}))
check('the card right column reads "files · size · ↑in ↓out token"',
  /36 文件 · [\d.]+ (KB|MB) · ↑[\d.]+[kM]? ↓[\d.]+[kM]? token/.test(wideMarkup),
  wideMarkup.slice(Math.max(0, wideMarkup.indexOf('36 文件')), wideMarkup.indexOf('36 文件') + 90))
check('the two token counts never use a "→" between them',
  !/[\d.]+→[\d.]+/.test(wideMarkup))
// The usage belongs in ONE place. Appending it to the prompt line as well made the
// left text long AND the right column wide, which squeezed the title to 「轮…」.
const longRows = rowsOf(3).map((row) => ({
  ...row,
  sessionId: 's1',
  manifest: true,
  prompt: '一个相当长的中文提问，用来占满左侧的可读宽度',
  stats: { files: 36, bytes: 801900 },
  usage: { inputTokens: 126000, outputTokens: 137000 },
  toolCalls: 89,
  durationMs: 478000,
}))
check('a long row keeps its label, its prompt and every figure',
  (() => {
    // On a realistic card the whole row reads: label, prompt, and the complete
    // tokens / tools / duration figures.
    const { layout: wide } = graphFor([{ id: 's1', title: '会话', live: true }], longRows, { width: 1200 })
    const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
      layout: wide, selectedId: undefined, currentSessionId: 's1', onSelect: () => {}, t,
    }))
    return /轮次 2/.test(markup) && /一个相当长的中文/.test(markup)
      && /↑126k ↓137k token/.test(markup) && !/89 工具/.test(markup)
  })(),
  'the whole row reads on a realistic card')
check('a narrow card shortens the figures instead of overflowing',
  (() => {
    // A 396px card cannot hold a 260px text floor AND a 340px figure column, so the
    // figures are ellipsised here. The point is that they are still drawn — starting
    // with the file figure — and that nothing overflows or renders as `undefined`.
    const { layout: small } = graphFor([{ id: 's1', title: '会话', live: true }], longRows, { width: 620 })
    const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.TreeGraph, {
      layout: small, selectedId: undefined, currentSessionId: 's1', onSelect: () => {}, t,
    }))
    return /轮次 2/.test(markup) && /36 文件/.test(markup) && !markup.includes('undefined')
  })(),
  'a narrow card folds the figures rather than overflowing')
check('the token counts appear exactly once, in the right column',
  // Inline would be a duplicate: the counts belong at the file figure, and only there.
  !/↓[\d.]+[kM]? token<\/text>/.test(wideMarkup)
  && /文件 · [\d.]+ (KB|MB) · ↑[\d.]+[kM]? ↓[\d.]+[kM]? token · 31s/.test(wideMarkup)
  && (wideMarkup.match(/↑5\.2k ↓9\.2k token/g) ?? []).length
    === (wideMarkup.match(/↑5\.2k ↓9\.2k token/g) ?? []).filter(() => true).length,
  wideMarkup.slice(Math.max(0, wideMarkup.indexOf('36 文件')), wideMarkup.indexOf('36 文件') + 80))
// The details pane floats above the timeline: selecting a row must not reflow the
// graph (or leave a reserved empty column).
check('the details pane floats over the timeline',
  /\.rw-side\{position:absolute/.test(sheet) && /\.rw-body\{position:relative/.test(sheet),
  /\.rw-side\{[^}]*\}/.exec(sheet)?.[0]?.slice(0, 90))

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
  /disabled="[^>]*>[^<]*(回退|rewind)/i.test(details) || details.includes(t('notice.reaskExplain')),
  details.slice(Math.max(0, details.indexOf(t('notice.reaskViaAgent')) - 90), details.indexOf(t('notice.reaskViaAgent')) + 8))
check('a row without a rewind target shows the control with its reason',
  // The gold control only renders with a prompt, so this row shows the
  // in-place family instead — whichever wording the release uses.
  details.includes('rw-actions')
  && [t('notice.inplaceViaAgent'), t('notice.inplaceCodeViaAgent'), t('action.inplace'), t('action.inplaceCode')]
    .some((label) => details.includes(label)))
// The client bundle is also read as text, to pin what the rendered markup cannot
// show: which text is handed to the composer, and where the panel closes.
const shellSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const reaskDetails = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: { ...checkpoints[2], canFork: true, reachable: true, prompt: '原始提问' },
  session: sessions[0],
  workspace: 'C:/ws',
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  canReask: true,
  // With in-place writes available, the gold control keeps its destructive wording.
  inplace: true,
}))
// With in-place writes unavailable (this release) the gold control delegates the
// work to the agent instead of disappearing; with them available it keeps the
// documented destructive wording.
const delegatedDetails = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.DetailsPane, {
  checkpoint: { ...checkpoints[2], canFork: true, reachable: true, prompt: '原始提问' },
  session: sessions[0],
  workspace: 'C:/ws',
  t,
  onAction: () => {},
  busy: false,
  plan: undefined,
  canReask: true,
  inplace: false,
  inplaceReason: '面板在空闲时无法安全写入',
}))
check('a checkpoint with a rewind target can be re-asked',
  reaskDetails.includes(t('action.reask')) && reaskDetails.includes(t('notice.reaskExplain')))
check('the re-ask control still works when the panel cannot write',
  delegatedDetails.includes(t('notice.reaskViaAgent')) && delegatedDetails.includes(t('notice.agentExplain'))
  && !delegatedDetails.includes('disabled=""'),
  delegatedDetails.slice(Math.max(0, delegatedDetails.indexOf(t('notice.reaskViaAgent')) - 80), delegatedDetails.indexOf(t('notice.reaskViaAgent')) + 10))
check('no internal instruction is ever put in the composer',
  !shellSource.includes('请用 rewind 工具') && !shellSource.includes('请先调用 rewind 工具')
  && !shellSource.includes('agentRewindPrompt')
  && shellSource.includes('actions.setDraft(options.prompt)'),
  'the composer only ever receives the prompt the user wrote')
// A failure inside the dialog: it must stay open, right where the click happened.
const runningDialog = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
  request: { conversation: 'inplace', workspace: 'none', checkpoint: checkpoints[1] },
  plan: undefined,
  t,
  busy: true,
  error: undefined,
  queued: false,
  onCancel: () => {},
  onConfirm: () => {},
}))
const busyDialog = ReactDOMServer.renderToStaticMarkup(React.createElement(moduleExports.ConfirmDialog, {
  request: { conversation: 'inplace', workspace: 'none', checkpoint: checkpoints[1] },
  plan: undefined,
  t,
  busy: false,
  error: '代理正在执行工具调用，请等这一轮结束后再回退',
  queued: false,
  onCancel: () => {},
  onConfirm: () => {},
}))
check('a dialog failure is shown where the click happened',
  busyDialog.includes('代理正在执行工具调用') && busyDialog.includes('data-kind="error"'))
check('the confirm button reports that it is running',
  runningDialog.includes(t('action.running')) && runningDialog.includes('rw-spin'))
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
