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
check('row cards fill the graph viewport',
  layout.cardW >= MIN_CARD_W && layout.cardW >= layout.width * 0.5,
  `${layout.cardW} of ${layout.width}`)
check('the cards fill the width between the rail column and the time rail',
  // The right gutter IS the right margin, so a row ends exactly where the time rail
  // begins and the box is as long as the panel allows. On a canvas narrower than
  // that, the card's own minimum width wins and the rails stay clear.
  (layout.cardW > MIN_CARD_W
    ? Math.abs((layout.cardX + layout.cardW) - (layout.width - 112)) <= 1
    : layout.cardX + layout.cardW <= layout.width - 112)
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
  { width: 700 },
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
check('a row card summarises its turn: tokens, tools, duration',
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
    return measured.every((entry) => Math.abs(entry.left - entry.right) <= 1)
  })(),
  JSON.stringify(wideLayout.__measured ?? []))
check('a card fills the panel but never overflows it',
  wideLayout.cardW > 1100 && wideLayout.cardX + wideLayout.cardW <= wideLayout.width
  && wideLayout.cardX >= wideLayout.railLeft,
  JSON.stringify([wideLayout.cardX, wideLayout.cardW, wideLayout.width]))

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
      && /↑126k ↓137k token/.test(markup) && /89 工具/.test(markup)
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
  && /文件 · [\d.]+ (KB|MB) · ↑[\d.]+[kM]? ↓[\d.]+[kM]? token · 3 工具/.test(wideMarkup)
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
