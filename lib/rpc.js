/**
 * HTTP transport for dsh-plugin-rewind.
 *
 * A static client plugin has no `host.call` (that symbol only exists for
 * model-authored dynamic packages), so the browser half talks to this half the
 * way every shipped out-of-tree plugin does: a same-origin `POST` to a route
 * the host registered with `ctx.webServer.register`. The envelope is the one
 * the installed third-party plugins use:
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 *
 * @module dsh-plugin-rewind/rpc
 */
import { RewindError } from './engine.js'

/** Bodies above this size are rejected: every request here is small JSON. */
const MAX_BODY_BYTES = 1 << 20

/** Methods that change durable state need an explicit `confirm: true`. */
const NEEDS_CONFIRM = new Set(['apply', 'gc'])

/** Write one envelope. */
function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Read a JSON request body, or null when it is unusable. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    chunks.push(chunk)
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      req.destroy?.()
      return null
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Whether an IPv4 or IPv6 literal is a loopback address. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice(7))
  const parts = address.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)) && parts[0] === '127'
}

/** Whether a hostname names the local machine. */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''))
}

/**
 * Loopback-only fence. The socket address is authoritative; `X-Forwarded-For`
 * is deliberately never consulted. A rewind route can delete workspace files,
 * so a LAN peer must not reach it even on a trusted-host deployment.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Build the route handler.
 *
 * @param engine - a `RewindEngine`.
 * @param options - `routePath` (default `/dsh-rewind/rpc`) and `logger`.
 * @returns an `async (req, res)` handler for `ctx.webServer.register`.
 */
export function createRpcHandler(engine, options = {}) {
  const logger = options.logger ?? (() => {})

  /** Dispatch one method call to the engine. */
  async function dispatch(method, params) {
    switch (method) {
      case 'status':
        return engine.status()

      case 'overview': {
        // A sessionId is optional: the host then picks the most recently active
        // live root session, so a browser shell that cannot resolve its own
        // active session still gets a usable tree.
        const requested = typeof params.sessionId === 'string' && params.sessionId !== ''
          ? params.sessionId
          : undefined
        const sessionId = requested ?? await engine.pickSession()
        if (sessionId !== undefined) await engine.backfill(sessionId)
        return engine.overview(requested)
      }

      case 'snapshot': {
        const sessionId = params.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new RewindError('bad-request', 'snapshot requires a sessionId')
        }
        const afterTurn = await engine.currentTurnOf(sessionId)
        const checkpoint = await engine.enqueue(sessionId, () => engine.createCheckpoint({
          sessionId,
          afterTurn,
          kind: 'manual',
          withManifest: true,
          label: typeof params.label === 'string' && params.label !== ''
            ? params.label
            : `手动检查点 · 第 ${afterTurn} 轮后`,
          prompt: typeof params.prompt === 'string' ? params.prompt : '',
        }))
        return { checkpoint }
      }

      case 'plan':
        return engine.plan(params.checkpointId, {
          conversation: params.conversation,
          workspace: params.workspace,
        })

      case 'apply': {
        if (params.confirm !== true) {
          throw new RewindError('not-confirmed', '回退操作需要显式确认')
        }
        // While the agent is using tools the rewind is held and reported as
        // queued, rather than refused: the panel then says it is waiting instead
        // of appearing to ignore the click. `queue: false` forces an immediate
        // attempt (the panel's "run now" retry).
        const outcome = await engine.applyOrQueue(params.checkpointId, {
          conversation: params.conversation,
          workspace: params.workspace,
          queueWhenBusy: params.queue !== false,
        })
        return outcome.queued === true ? outcome : { queued: false, ...outcome.report }
      }

      case 'cancelQueued': {
        const sessionId = typeof params.sessionId === 'string' && params.sessionId !== ''
          ? params.sessionId
          : await engine.pickSession()
        if (sessionId === undefined) throw new RewindError('bad-request', 'cancelQueued needs a session')
        return engine.cancelPending(sessionId)
      }

      case 'remove':
        return engine.remove(params.checkpointId)

      case 'gc':
        return engine.collectGarbage()

      default:
        throw new RewindError('unknown-method', `unknown method ${String(method)}`)
    }
  }

  return async function handler(req, res) {
    if (!isLoopbackRequest(req)) {
      json(res, { ok: false, error: { code: 'forbidden', message: 'loopback clients only' } }, 403)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      json(res, { ok: false, error: { code: 'bad-request', message: 'content-type must be application/json' } }, 415)
      return
    }
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object') {
      json(res, { ok: false, error: { code: 'bad-request', message: 'malformed request body' } })
      return
    }
    const method = typeof body.method === 'string' ? body.method : ''
    const params = body.params === undefined || body.params === null ? {} : body.params
    if (typeof params !== 'object' || Array.isArray(params)) {
      json(res, { ok: false, error: { code: 'bad-request', message: 'params must be an object' } })
      return
    }
    if (NEEDS_CONFIRM.has(method) && params.confirm !== true) {
      json(res, { ok: false, error: { code: 'not-confirmed', message: 'this method requires confirm: true' } })
      return
    }
    try {
      const value = await dispatch(method, params)
      json(res, { ok: true, value })
    } catch (error) {
      const code = error instanceof RewindError ? error.code : 'internal'
      const message = String(error?.message ?? error)
      if (code === 'internal') logger(`dsh-plugin-rewind: ${method} failed: ${message}`)
      json(res, { ok: false, error: { code, message } })
    }
  }
}
