import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { herdr, HerdrError } from './herdr.js'
import { cleanFeed, hashFeed } from './feed.js'
import { loadTheme } from './theme.js'

const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/** How Herdr's error codes map onto HTTP. Anything unlisted is a 502. */
const STATUS_FOR_CODE = {
  socket_unavailable: 503,
  timeout: 504,
  agent_not_found: 404,
  pane_not_found: 404,
  agent_not_ready: 409,
  invalid_key: 400,
  empty_agent_prompt: 400,
  method_not_allowed: 500, // only reachable via a bug in this codebase
}

const STATUS_ORDER = { blocked: 0, working: 1, idle: 2 }

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendError(res, err) {
  if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } })
  if (err instanceof HerdrError) {
    console.error(`herdr error ${err.code}: ${err.message}`)
    return sendJson(res, STATUS_FOR_CODE[err.code] ?? 502, { error: { code: err.code, message: err.message } })
  }
  console.error('unhandled error', err)
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
}

/**
 * Confirms the pane is a live agent pane right now, and returns its AgentInfo.
 *
 * Called before every mutation. Pane ids such as `w8:p1` are recycled once a
 * pane closes, so a stale id from a phone that has been in a pocket for an hour
 * must never write into whatever shell now holds that slot.
 */
export async function requireLiveAgent(paneId) {
  const { agents } = await herdr('agent.list', {})
  const agent = agents.find((a) => a.pane_id === paneId)
  if (!agent) throw new HttpError(404, 'agent_not_found', `agent ${paneId} is no longer running`)
  return agent
}

function projectAgent(a) {
  return {
    pane_id: a.pane_id,
    agent: a.agent,
    status: a.agent_status ?? 'unknown',
    title: a.terminal_title_stripped || a.terminal_title || a.agent || a.pane_id,
    cwd: a.cwd ?? '',
    dir: (a.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
    state_change_seq: a.state_change_seq ?? 0,
  }
}

async function listAgents(res) {
  const { agents } = await herdr('agent.list', {})
  const projected = agents
    .map(projectAgent)
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || a.title.localeCompare(b.title)
    )
  sendJson(res, 200, { agents: projected })
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '')
  const file = join(STATIC_DIR, rel)
  if (!file.startsWith(STATIC_DIR)) return sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      // The service worker must never be served from cache, or a broken one
      // is unrecoverable without clearing site data on the phone.
      'cache-control': rel.endsWith('sw.js') ? 'no-cache' : 'no-store',
    })
    res.end(body)
  } catch {
    sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
  }
}

/**
 * Tailscale Serve injects Tailscale-User-Login on proxied requests and does not
 * populate it for tagged devices — which is 52 of the 56 nodes on this tailnet.
 * That is the whole authentication story, so this is a strict equality with no
 * fallback path. Unset or empty ALLOWED_LOGIN fails closed: `undefined ===
 * undefined` would otherwise authorise unauthenticated requests.
 */
function authorised(req) {
  if (process.env.DEV_BYPASS_AUTH === '1') return true
  const allowed = process.env.ALLOWED_LOGIN
  return typeof allowed === 'string' && allowed !== '' && req.headers['tailscale-user-login'] === allowed
}

const DEFAULT_LINES = { visible: 60, recent: 200 }
const MAX_LINES = 500

async function readFeed(res, paneId, query) {
  const agent = await requireLiveAgent(paneId)

  const source = query.get('source') === 'recent' ? 'recent' : 'visible'
  const requested = Number.parseInt(query.get('lines') ?? '', 10)
  const lines = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_LINES)
    : DEFAULT_LINES[source]

  // The payload is nested at result.read, not on result directly.
  const { read } = await herdr('agent.read', { target: paneId, source, lines, strip_ansi: true })

  const text = cleanFeed(read.text ?? '')
  const hash = hashFeed(text)
  const status = agent.agent_status ?? 'unknown'

  if (query.get('h') === hash) return sendJson(res, 200, { unchanged: true, hash, status })
  sendJson(res, 200, { text, hash, truncated: Boolean(read.truncated), status })
}

const MAX_BODY = 64 * 1024

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_request', 'body is not valid JSON')
  }
}

const sendInput = (paneId, text) => herdr('pane.send_input', { pane_id: paneId, text, keys: ['enter'] })

async function sendText(req, res, paneId) {
  const { text } = await readJsonBody(req)

  // Checked before any socket work: Herdr answers empty_agent_prompt for this,
  // and there is no reason to spend a round trip discovering that.
  if (typeof text !== 'string' || text.trim() === '') {
    throw new HttpError(400, 'empty_text', 'text is required')
  }

  const agent = await requireLiveAgent(paneId)

  // agent.prompt refuses a blocked agent outright (src/app/api/agents.rs:146),
  // and blocked is exactly the state worth answering from a phone.
  if (agent.agent_status === 'blocked') {
    await sendInput(paneId, text)
    return sendJson(res, 200, { ok: true, via: 'pane.send_input' })
  }

  // Preferred when not blocked: agent.prompt is agent-aware. It checks the
  // expected agent still owns the pane foreground and carries per-agent submit
  // workarounds, such as the Copilot focus event at agents.rs:182.
  try {
    await herdr('agent.prompt', { target: paneId, text })
    return sendJson(res, 200, { ok: true, via: 'agent.prompt' })
  } catch (err) {
    // Required, not defensive: agent_status came from a separate round trip, so
    // the agent can block in between. Without this the reply vanishes silently.
    if (!(err instanceof HerdrError) || err.code !== 'agent_blocked') throw err
    await sendInput(paneId, text)
    return sendJson(res, 200, { ok: true, via: 'pane.send_input' })
  }
}

/**
 * The only keys the adapter will send. Mirrored by the client's palette row.
 * Herdr answers invalid_key for anything it does not recognise; validating here
 * keeps that a 400 rather than a 502 and keeps the surface deliberately small.
 */
export const KEY_PALETTE = new Set([
  '1', '2', '3', 'y', 'n', 'enter', 'esc', 'up', 'down', 'tab', 'shift+tab', 'ctrl+c',
])

async function sendKeys(req, res, paneId) {
  const { keys } = await readJsonBody(req)
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => KEY_PALETTE.has(k))) {
    throw new HttpError(400, 'invalid_key', 'keys must be a non-empty array drawn from the palette')
  }
  await requireLiveAgent(paneId)
  await herdr('pane.send_input', { pane_id: paneId, keys })
  sendJson(res, 200, { ok: true })
}

async function focusAgent(res, paneId) {
  await requireLiveAgent(paneId)
  await herdr('agent.focus', { target: paneId })
  sendJson(res, 200, { ok: true })
}

async function route(req, res, url) {
  const { pathname } = url

  if (pathname === '/api/agents' && req.method === 'GET') return listAgents(res)

  const feed = pathname.match(/^\/api\/agents\/([^/]+)\/feed$/)
  if (feed && req.method === 'GET') return readFeed(res, decodeURIComponent(feed[1]), url.searchParams)

  const send = pathname.match(/^\/api\/agents\/([^/]+)\/send$/)
  if (send && req.method === 'POST') return sendText(req, res, decodeURIComponent(send[1]))

  const keys = pathname.match(/^\/api\/agents\/([^/]+)\/keys$/)
  if (keys && req.method === 'POST') return sendKeys(req, res, decodeURIComponent(keys[1]))

  const focus = pathname.match(/^\/api\/agents\/([^/]+)\/focus$/)
  if (focus && req.method === 'POST') return focusAgent(res, decodeURIComponent(focus[1]))

  // Re-read per request. The file is a few KB and this is fetched once per app
  // load, so caching or watching it would be complexity with no payoff.
  if (pathname === '/api/theme' && req.method === 'GET') return sendJson(res, 200, loadTheme())

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname)

  throw new HttpError(404, 'not_found', 'no such endpoint')
}

export function createServer() {
  return http.createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_request', message: 'malformed url' } })
    }

    if (!authorised(req)) {
      return sendJson(res, 403, { error: { code: 'forbidden', message: 'not authorised' } })
    }

    try {
      await route(req, res, url)
    } catch (err) {
      sendError(res, err)
    }
  })
}

// Only listen when run directly, so tests can import createServer freely.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.BIND_HOST ?? '127.0.0.1'
  createServer().listen(PORT, host, () =>
    console.log(`herdr-pwa listening on ${host}:${PORT}`)
  )
}
