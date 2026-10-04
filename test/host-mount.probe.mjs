/**
 * Host-half mount test: loads `lib/index.js` the way the Cordis loader does,
 * mounts it on a fake context, and then drives the plugin through a REAL HTTP
 * round trip against the route it registered.
 *
 * This is the closest offline equivalent of the running harness: it proves the
 * plugin entry evaluates, the route/effect/listener wiring is complete, the
 * loopback fence works, and the RPC envelope carries a live overview.
 *
 * Run: node test/host-mount.probe.mjs
 */
import { promises as fs } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const MODULES = process.env.DSH_MODULES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules'
const loadFromProfile = (relative) => import(pathToFileURL(join(MODULES, relative)).href)
const { Session } = await loadFromProfile('@deepseek-ai/dsh-session/lib/index.js')

const here = fileURLToPath(new URL('.', import.meta.url))
const sandbox = join(here, '.tmp', `mount-${Date.now().toString(36)}`)
const root = join(sandbox, 'ws')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}

await fs.mkdir(root, { recursive: true })
await fs.writeFile(join(root, 'index.js'), 'export const version = 1\n')

// ── a fake cordis context that records what the plugin registers ────────────
const registered = { routes: [], listeners: [], effects: [], tools: [], sections: [], warnings: [] }
const session = Session.create('session-mount-1', [], {
  version: 0,
  id: 'session-mount-1',
  createdAt: Date.now(),
  cwd: root,
  delegationDepth: 0,
  agentPreset: 'standard',
})
session.append('turn/start', { turn: 1 })
session.append('user/message', {
  id: 'u1',
  role: 'user',
  source: { kind: 'user', rpcId: 'rpc-1' },
  content: [{ type: 'text', text: '第一轮' }],
}, { surfaceOp: 'append' })
session.append('assistant/message', {
  turn: 1,
  step: 1,
  message: {
    id: 'm1',
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    content: [{ type: 'text', text: '回答' }],
  },
}, { surfaceOp: 'append', sourceEventSeqs: [] })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

const fakeCtx = {
  logger: (name) => ({ warn: (message) => registered.warnings.push(`${name}: ${message}`) }),
  effect: (callback, label) => {
    registered.effects.push(label)
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on: (event, listener) => {
    registered.listeners.push({ event, listener })
    return () => {}
  },
  get: (name) => {
    if (name === 'tools') return { register: (definition) => { registered.tools.push(definition); return () => {} } }
    if (name === 'systemPrompt') return { section: (value) => { registered.sections.push(value); return () => {} } }
    return undefined
  },
  sessions: {
    get: (id) => (id === session.id ? session : undefined),
    list: () => [session],
  },
  webServer: {
    register: (value) => {
      registered.routes.push(value)
      return () => {}
    },
  },
}

// ── mount ──────────────────────────────────────────────────────────────────
const host = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
check('the host half exports a cordis plugin name', host.name === 'rewind')
check('the host half declares its hard dependencies',
  Array.isArray(host.inject) && host.inject.includes('webServer') && host.inject.includes('sessions'),
  JSON.stringify(host.inject))

host.apply(fakeCtx, { storeRoot: join(sandbox, 'store') })
await new Promise((resolve) => setTimeout(resolve, 50))

check('the plugin registers exactly one route', registered.routes.length === 1, String(registered.routes.length))
check('the route is the exact RPC path the browser half posts to',
  registered.routes[0]?.kind === 'exact' && registered.routes[0]?.path === '/dsh-rewind/rpc',
  JSON.stringify(registered.routes.map((route) => [route.kind, route.path])))
check('the route handler is an async function', typeof registered.routes[0]?.handler === 'function')
check('the plugin subscribes to session events',
  registered.listeners.some((entry) => entry.event === 'session/event'))
check('the plugin wraps tool execution to track in-flight work',
  registered.listeners.some((entry) => entry.event === 'tools/execute'))
check('the plugin registers a model tool', registered.tools.length === 1 && registered.tools[0].name === 'rewind',
  JSON.stringify(registered.tools.map((tool) => tool?.name)))
check('the model tool declares parameters and an output contract',
  registered.tools[0]?.parameters?.properties?.action !== undefined && registered.tools[0]?.output?.render !== undefined,
  JSON.stringify(Object.keys(registered.tools[0]?.parameters?.properties ?? {})))
check('the plugin announces itself in the system-prompt band',
  registered.sections.length === 1 && registered.sections[0].name === 'plugin:dsh-plugin-rewind'
  && registered.sections[0].text.includes('dsh-plugin-rewind'),
  JSON.stringify(registered.sections.map((section) => section.name)))
// Authorship travels with the plugin: metadata, the agent's system-prompt band,
// and the tool description all name the author and link the repository.
check('the plugin exports its author and repository',
  host.AUTHOR?.name === 'joker123-wpx'
  && host.AUTHOR.repository === 'https://github.com/joker123-wpx/Deepseek-Harness-Code-revert',
  JSON.stringify(host.AUTHOR))
check('the system-prompt band credits the author with a link',
  registered.sections[0].text.includes('joker123-wpx')
  && registered.sections[0].text.includes('https://github.com/joker123-wpx/Deepseek-Harness-Code-revert'))
check('the model tool description credits the author',
  String(registered.tools[0]?.description ?? '').includes('joker123-wpx')
  && String(registered.tools[0]?.description ?? '').includes('Deepseek-Harness-Code-revert'),
  String(registered.tools[0]?.description ?? '').slice(-80))
check('every registration is owned by an effect',
  registered.effects.length >= 3 && registered.effects.every((label) => typeof label === 'string'),
  registered.effects.join(' | '))
check('mounting produced no warnings', registered.warnings.length === 0, registered.warnings.join(' | '))

// ── the model tool must run through its real wrapper ───────────────────────
const toolExec = { agent: { session }, signal: new AbortController().signal }
let toolStatus
let toolError = ''
try {
  toolStatus = await registered.tools[0].execute({ action: 'status' }, toolExec)
} catch (error) {
  toolError = `${error?.message ?? error}\n${error?.stack ?? ''}`
}
check('the model tool answers action=status', toolError === '' && Array.isArray(toolStatus?.checkpoints),
  toolError.split('\n').slice(0, 3).join(' | '))
check('the tool reports the checkpoint it backfilled',
  (toolStatus?.checkpoints ?? []).length >= 1
  && toolStatus.checkpoints[0].afterTurn !== undefined,
  JSON.stringify(toolStatus?.checkpoints?.slice(0, 2)))
let toolApplyError = ''
try {
  await registered.tools[0].execute({ action: 'apply', checkpoint_id: 'nope' }, toolExec)
} catch (error) {
  toolApplyError = String(error?.message ?? error)
}
check('the model tool refuses an unknown checkpoint id', toolApplyError.includes('no checkpoint'), toolApplyError)
let toolArgsError = ''
try {
  await registered.tools[0].execute({ action: 'bogus' }, toolExec)
} catch (error) {
  toolArgsError = String(error?.message ?? error)
}
check('the tool argument DSL rejects an out-of-enum value', toolArgsError !== '', toolArgsError.slice(0, 120))

// ── real HTTP round trip ───────────────────────────────────────────────────
const server = createServer(registered.routes[0].handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const endpoint = `http://127.0.0.1:${port}/dsh-rewind/rpc`

/** POST one RPC call and decode the envelope. */
async function call(method, params, init = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    ...init,
  })
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

const status = await call('status', {})
check('status answers over HTTP', status.status === 200 && status.body?.ok === true, JSON.stringify(status.body).slice(0, 160))
check('status reports the store root', typeof status.body?.value?.storeRoot === 'string')

const overview = await call('overview', { sessionId: session.id })
check('overview answers over HTTP', overview.body?.ok === true, JSON.stringify(overview.body).slice(0, 200))
check('overview backfilled the existing turn',
  overview.body?.value?.checkpoints?.length === 1, JSON.stringify(overview.body?.value?.checkpoints?.map((c) => c.afterTurn)))
check('the backfilled checkpoint has no file snapshot yet (history only)',
  overview.body?.value?.checkpoints?.[0]?.manifest === false)

const snapshot = await call('snapshot', { sessionId: session.id })
check('a manual checkpoint writes a file snapshot', snapshot.body?.ok === true && snapshot.body.value.checkpoint.manifest === true,
  JSON.stringify(snapshot.body?.value?.checkpoint?.stats))

const plan = await call('plan', { checkpointId: snapshot.body.value.checkpoint.id, workspace: 'restore' })
check('plan answers with a dry-run workspace diff', plan.body?.ok === true && plan.body.value.workspace?.ok === true)

const unconfirmed = await call('apply', { checkpointId: snapshot.body.value.checkpoint.id, workspace: 'restore' })
check('apply refuses to run without an explicit confirmation',
  unconfirmed.body?.ok === false && unconfirmed.body.error.code === 'not-confirmed', JSON.stringify(unconfirmed.body))

const noSession = await call('overview', {})
check('overview without a session id auto-selects one',
  noSession.body?.ok === true && noSession.body.value.autoSelected === true
  && typeof noSession.body.value.currentSessionId === 'string',
  JSON.stringify({ auto: noSession.body?.value?.autoSelected, id: noSession.body?.value?.currentSessionId }))

const badSnapshot = await call('snapshot', { sessionId: 42 })
check('a non-string session id is a typed bad-request',
  badSnapshot.body?.ok === false && badSnapshot.body.error.code === 'bad-request', JSON.stringify(badSnapshot.body))

const unknown = await call('does-not-exist', {})
check('an unknown method is a typed error',
  unknown.body?.ok === false && unknown.body.error.code === 'unknown-method')

const badContent = await call('status', {}, { headers: { 'content-type': 'text/plain' } })
check('a non-JSON content type is rejected with 415', badContent.status === 415, String(badContent.status))

const getResponse = await fetch(endpoint)
check('a GET on the RPC route is rejected with 405', getResponse.status === 405, String(getResponse.status))

// ── the loopback fence and the CSRF guard ──────────────────────────────────
const crossSite = await call('status', {}, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })
check('a cross-site request is refused', crossSite.status === 403 && crossSite.body?.ok === false, String(crossSite.status))
const foreignOrigin = await call('status', {}, {
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
})
check('a foreign Origin is refused', foreignOrigin.status === 403, String(foreignOrigin.status))

await new Promise((resolve) => server.close(resolve))

// ── the turn-boundary hook actually snapshots ──────────────────────────────
const eventListener = registered.listeners.find((entry) => entry.event === 'session/event').listener
const toolListener = registered.listeners.find((entry) => entry.event === 'tools/execute').listener
let toolRan = false
await toolListener({ agent: { session }, name: 'write', arguments: {} }, async () => { toolRan = true; return { ok: true } })
check('the tool wrapper still runs the tool body', toolRan === true)

eventListener(session, { type: 'turn/start', data: { turn: 2 } })
eventListener(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] } })
eventListener(session, { type: 'turn/end', data: { turn: 2 } })
await new Promise((resolve) => setTimeout(resolve, 400))
const overviewAfter = await (async () => {
  const server2 = createServer(registered.routes[0].handler)
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${server2.address().port}/dsh-rewind/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'overview', params: { sessionId: session.id } }),
  })
  const body = await response.json()
  await new Promise((resolve) => server2.close(resolve))
  return body
})()
const checkpoints = overviewAfter?.value?.checkpoints ?? []
check('a completed turn created its own file checkpoint automatically',
  checkpoints.some((checkpoint) => checkpoint.afterTurn === 2 && checkpoint.manifest === true),
  JSON.stringify(checkpoints.map((checkpoint) => [checkpoint.afterTurn, checkpoint.kind, checkpoint.manifest])))
check('the automatic checkpoint carries the turn prompt',
  checkpoints.some((checkpoint) => checkpoint.afterTurn === 2 && checkpoint.prompt === '第二轮'),
  JSON.stringify(checkpoints.map((checkpoint) => checkpoint.prompt)))
check('the turn-boundary snapshot recorded the workspace files',
  (checkpoints.find((checkpoint) => checkpoint.afterTurn === 2)?.stats?.files ?? 0) >= 1,
  JSON.stringify(checkpoints.find((checkpoint) => checkpoint.afterTurn === 2)?.stats))
check('no warnings were logged while running', registered.warnings.length === 0, registered.warnings.join(' | '))

// ── provenance telemetry over the wire ─────────────────────────────────────
// Which browser build is calling, and what it asked for, is what makes a field
// report answerable. The client stamps its build id on every request.
const telemetryServer = createServer(registered.routes[0].handler)
await new Promise((resolve) => telemetryServer.listen(0, '127.0.0.1', resolve))
const telemetryPort = telemetryServer.address().port
const telemetryCall = async (body) => {
  const response = await fetch(`http://127.0.0.1:${telemetryPort}/dsh-rewind/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}
await telemetryCall({ method: 'overview', params: {}, client: 'build-from-test' })
const refused = await telemetryCall({
  method: 'apply',
  params: { checkpointId: 'whatever', conversation: 'inplace' },
  client: 'build-from-test',
})
check('an unconfirmed apply is refused', refused?.ok === false
  && refused.error.code === 'not-confirmed', JSON.stringify(refused))
const logged = await telemetryCall({ method: 'status', params: {}, client: 'build-from-test' })
const entries = logged?.value?.rpcLog ?? []
check('the refused call is recorded with its client build',
  entries.some((entry) => entry.method === 'apply' && entry.outcome === 'not-confirmed'
    && entry.client === 'build-from-test'),
  JSON.stringify(entries.slice(-3)))
check('reads are not recorded as state changes',
  entries.every((entry) => ['apply', 'snapshot', 'remove', 'gc', 'cancelQueued'].includes(entry.method)),
  JSON.stringify(entries.map((entry) => entry.method)))
check('status reports the calling browser build',
  logged?.value?.client?.build === 'build-from-test', JSON.stringify(logged?.value?.client))
// The panel's idle rollback is scheduled over the wire, so nothing internal has to
// be typed into the conversation.
const scheduledBad = await telemetryCall({
  method: 'scheduleRewind',
  params: { sessionId: 'session-mount-1', checkpointId: 'cp-does-not-exist' },
  client: 'build-from-test',
})
check('an unknown checkpoint cannot be scheduled', scheduledBad?.ok === false
  && scheduledBad.error.code === 'unknown-checkpoint', JSON.stringify(scheduledBad))
const scheduledReal = await telemetryCall({
  method: 'scheduleRewind',
  params: { sessionId: 'session-mount-1', checkpointId: snapshot.body.value.checkpoint.id },
  client: 'build-from-test',
})
check('a real checkpoint can be scheduled for the next turn',
  scheduledReal?.ok === true && scheduledReal.value.scheduled === true,
  JSON.stringify(scheduledReal))
const scheduledStatus = await telemetryCall({ method: 'status', params: {}, client: 'build-from-test' })
check('the scheduled call is recorded as a state change',
  (scheduledStatus?.value?.rpcLog ?? []).some((entry) => entry.method === 'scheduleRewind'
    && entry.client === 'build-from-test'),
  JSON.stringify((scheduledStatus?.value?.rpcLog ?? []).map((entry) => entry.method)))
await new Promise((resolve) => telemetryServer.close(resolve))

await fs.rm(sandbox, { recursive: true, force: true })

// The two halves report their build id; a mismatch is what "it still does not
// work" looks like when only the browser half was refreshed.
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const clientBuild = /const BUILD_ID = '([^']+)'/.exec(clientSource)?.[1]
check('the host exports a build id', typeof host.BUILD_ID === 'string' && host.BUILD_ID.length > 0,
  String(host.BUILD_ID))
check('both halves carry the same build id', clientBuild === host.BUILD_ID,
  JSON.stringify({ host: host.BUILD_ID, client: clientBuild }))
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}

