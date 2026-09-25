import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { herdr, subscribe, HerdrError } from './herdr.js'
import { cleanFeed, hashFeed } from './feed.js'
import { loadTheme } from './theme.js'

const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)

// Read once at startup: the version is baked into the image and cannot change
// while the process lives. Dockerfile already copies package.json into /app.
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version

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
  // A stream has already sent its 200; the phone learns of trouble in-band.
  if (res.headersSent) {
    console.error('error after headers were sent', err)
    return res.end()
  }
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

function projectAgent(a, spaces = new Map()) {
  return {
    pane_id: a.pane_id,
    agent: a.agent,
    status: a.agent_status ?? 'unknown',
    // The space label first: it is the name the user chose, whereas a terminal
    // title is whatever the agent last wrote there — often just "grok".
    title:
      spaces.get(a.workspace_id) ||
      a.terminal_title_stripped ||
      a.terminal_title ||
      a.agent ||
      a.pane_id,
    cwd: a.cwd ?? '',
    dir: (a.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
    state_change_seq: a.state_change_seq ?? 0,
  }
}

async function getAgents() {
  const [{ agents }, workspaces] = await Promise.all([
    herdr('agent.list', {}),
    // Labels are cosmetic, so a herdr that cannot answer this still gets a
    // usable list rather than a 502.
    herdr('workspace.list', {}).then((r) => r.workspaces ?? [], () => []),
  ])
  const spaces = new Map(workspaces.map((w) => [w.workspace_id, w.label]))
  return agents
    .map((a) => projectAgent(a, spaces))
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || a.title.localeCompare(b.title)
    )
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

// 1000 is Herdr's own ceiling for source=recent: it returns the same 1000-line
// payload for any larger request, so asking for more is just a bigger number.
const FEED_LINES = { visible: 60, recent: 1000 }

/**
 * Reads an agent's pane, cleaned for a phone, as `{text, hash, source}`.
 *
 * Scrollback is the default. `visible` is one phone-height of screen capture
 * with no history behind it, so opening there gives nothing to scroll up into.
 */
async function readPane(paneId, wanted) {
  const readSource = (source) =>
    herdr('agent.read', { target: paneId, source, lines: FEED_LINES[source], strip_ansi: true })
      // The payload is nested at result.read, not on result directly.
      .then((r) => ({ source, read: r.read }))

  let answer
  try {
    answer = await readSource(wanted)
  } catch (err) {
    // claude and grok paint to the alternate screen, so while they are working
    // Herdr cannot capture their history at all — it only exists as redrawn
    // screen state. The screen is still worth reading, so degrade to it.
    if (!(err instanceof HerdrError) || err.code !== 'agent_not_idle') throw err
    answer = await readSource('visible')
  }

  const text = cleanFeed(answer.read.text ?? '')
  return { text, hash: hashFeed(text), source: answer.source }
}

const ACTIVE = new Set(['working', 'blocked'])
// ponytail: Herdr 0.9.1 lists pane_output_changed for events.wait but answers
// unsupported_event_wait_match, so pane text is read on a timer while an agent
// works. Replace the read loop in streamFeed with that wait once Herdr has it.
const FEED_READ_MS = 500
// Input to an idle agent (an arrow, esc) may change the screen without
// changing its status, so the phone's own input keeps the feed read briefly.
const INPUT_BURST_MS = 2000
const RETRY_MS = 2000
// Under Tailscale Serve's idle timeout, so an open stream is never reaped.
const PING_MS = 15000

/**
 * Starts a server-sent event stream. `send` is a no-op once the phone has gone,
 * so nothing that finishes late has to check first.
 */
function openStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
  res.write(': open\n\n')
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
  const stream = {
    open: true,
    sub: null,
    send(event, data) {
      if (stream.open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    end: () => res.end(),
  }
  res.on('close', () => {
    stream.open = false
    clearInterval(ping)
    stream.sub?.close()
  })
  return stream
}

/**
 * Holds a Herdr subscription open for as long as `stream` is, and re-subscribes
 * when it drops: Herdr restarts on every `omarchy update`. `stream.resubscribe()`
 * re-makes it at once, for a caller whose subscription list has gone stale.
 */
async function follow(stream, { subscriptions, onStart, onEvent, onError }) {
  let again = false
  stream.resubscribe = () => {
    again = true
    stream.sub?.close()
  }
  while (stream.open) {
    try {
      stream.sub = subscribe(await subscriptions(), onEvent)
      if (!stream.open) return stream.sub.close()
      await stream.sub.started
      await onStart()
      await stream.sub.closed
      if (!again && stream.open) throw new HerdrError('socket_unavailable', 'herdr closed the subscription')
    } catch (err) {
      stream.sub?.close()
      if (!stream.open) return
      if (!again) {
        onError(err)
        if (!stream.open) return
        await sleep(RETRY_MS)
      }
    }
    again = false
  }
}

/** Wraps `fn` so calls never overlap: a call mid-run queues exactly one more run. */
function coalesce(fn) {
  let running = null
  let queued = false
  return () => {
    if (running) {
      queued = true
      return running
    }
    running = (async () => {
      try {
        do {
          queued = false
          await fn()
        } while (queued)
      } finally {
        running = null
      }
    })()
    return running
  }
}

const LIST_EVENTS = ['pane.created', 'pane.closed', 'pane.exited', 'pane.agent_detected'].map((type) => ({ type }))
const paneSet = (agents) => agents.map((a) => a.pane_id).sort().join()

/**
 * Pushes the agent list whenever Herdr says it may have changed. Herdr only
 * offers status events per pane, so the subscription names every agent pane
 * and is re-made when that set changes.
 */
async function streamAgents(res) {
  const stream = openStream(res)
  let covered = ''
  let last = ''
  const down = (err) => stream.send('down', { message: err.message })
  const push = coalesce(async () => {
    const agents = await getAgents()
    const body = JSON.stringify(agents)
    if (body !== last) {
      last = body
      stream.send('agents', { agents })
    }
    if (paneSet(agents) !== covered) stream.resubscribe()
  })

  await follow(stream, {
    subscriptions: async () => {
      const { agents } = await herdr('agent.list', {})
      covered = paneSet(agents)
      return [...LIST_EVENTS, ...agents.map((a) => ({ type: 'pane.agent_status_changed', pane_id: a.pane_id }))]
    },
    // Re-sent after every reconnect, even unchanged: it is what turns the light green.
    onStart: () => {
      last = ''
      return push()
    },
    onEvent: () => push().catch(down),
    onError: down,
  })
}

/** Every open feed stream's wake-up, by pane, so input from the phone can reach it. */
const feedNudges = new Map()
const nudge = (paneId) => feedNudges.get(paneId)?.forEach((fn) => fn())

/**
 * Pushes one agent's pane text as it changes, plus its status.
 *
 * Status and the pane closing come from Herdr as events. The text does not, so
 * it is read every FEED_READ_MS while the agent is working or blocked, or just
 * had input from the phone, and not at all otherwise.
 */
async function streamFeed(res, paneId, query) {
  const stream = openStream(res)
  const wanted = query.get('source') === 'visible' ? 'visible' : 'recent'
  let status = 'unknown'
  let hash = null
  let burstUntil = 0
  let looping = false

  const gone = () => {
    stream.send('gone', {})
    stream.end()
  }
  const fail = (err) => {
    // A closed or recycled pane is the agent ending, not Herdr being down.
    if (err.status === 404 || err.code === 'agent_not_found' || err.code === 'pane_not_found') return gone()
    stream.send('down', { message: err.message })
  }
  const read = coalesce(async () => {
    const feed = await readPane(paneId, wanted)
    if (feed.hash === hash) return
    hash = feed.hash
    stream.send('feed', { text: feed.text, source: feed.source })
  })
  const loop = async () => {
    looping = true
    try {
      // Checked after each read, so the read that follows going idle is the last.
      while (stream.open) {
        await read()
        if (!ACTIVE.has(status) && Date.now() >= burstUntil) break
        await sleep(FEED_READ_MS)
      }
    } catch (err) {
      fail(err)
    } finally {
      looping = false
    }
  }
  // Mid-loop, an extra read still lands the text from just before a change.
  const wake = () => (looping ? read().catch(fail) : loop())

  const nudges = feedNudges.get(paneId) ?? new Set()
  const onInput = () => {
    burstUntil = Date.now() + INPUT_BURST_MS
    wake()
  }
  feedNudges.set(paneId, nudges.add(onInput))
  res.on('close', () => {
    nudges.delete(onInput)
    if (nudges.size === 0) feedNudges.delete(paneId)
  })

  await follow(stream, {
    subscriptions: () => [
      { type: 'pane.closed' },
      { type: 'pane.exited' },
      { type: 'pane.agent_status_changed', pane_id: paneId },
    ],
    onStart: async () => {
      // Re-checked on every (re)subscribe: pane ids are recycled, and a close
      // that happened while disconnected will never arrive as an event.
      const agent = await requireLiveAgent(paneId)
      status = agent.agent_status ?? 'unknown'
      stream.send('status', { status })
      wake()
    },
    onEvent: (event, data) => {
      if (data?.pane_id !== paneId) return
      if (event !== 'pane.agent_status_changed') return gone()
      status = data.agent_status ?? 'unknown'
      stream.send('status', { status })
      wake()
      // An agent that quits back to the shell leaves the pane open.
      if (!ACTIVE.has(status)) requireLiveAgent(paneId).catch(fail)
    },
    onError: fail,
  })
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
    nudge(paneId)
    return sendJson(res, 200, { ok: true, via: 'pane.send_input' })
  }

  // Preferred when not blocked: agent.prompt is agent-aware. It checks the
  // expected agent still owns the pane foreground and carries per-agent submit
  // workarounds, such as the Copilot focus event at agents.rs:182.
  try {
    await herdr('agent.prompt', { target: paneId, text })
    nudge(paneId)
    return sendJson(res, 200, { ok: true, via: 'agent.prompt' })
  } catch (err) {
    // Required, not defensive: agent_status came from a separate round trip, so
    // the agent can block in between. Without this the reply vanishes silently.
    if (!(err instanceof HerdrError) || err.code !== 'agent_blocked') throw err
    await sendInput(paneId, text)
    nudge(paneId)
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
  nudge(paneId)
  sendJson(res, 200, { ok: true })
}

async function focusAgent(res, paneId) {
  await requireLiveAgent(paneId)
  await herdr('agent.focus', { target: paneId })
  nudge(paneId)
  sendJson(res, 200, { ok: true })
}

async function route(req, res, url) {
  const { pathname } = url

  if (pathname === '/api/agents' && req.method === 'GET') return sendJson(res, 200, { agents: await getAgents() })

  if (pathname === '/api/stream' && req.method === 'GET') return streamAgents(res)

  const stream = pathname.match(/^\/api\/agents\/([^/]+)\/stream$/)
  if (stream && req.method === 'GET') return streamFeed(res, decodeURIComponent(stream[1]), url.searchParams)

  const send = pathname.match(/^\/api\/agents\/([^/]+)\/send$/)
  if (send && req.method === 'POST') return sendText(req, res, decodeURIComponent(send[1]))

  const keys = pathname.match(/^\/api\/agents\/([^/]+)\/keys$/)
  if (keys && req.method === 'POST') return sendKeys(req, res, decodeURIComponent(keys[1]))

  const focus = pathname.match(/^\/api\/agents\/([^/]+)\/focus$/)
  if (focus && req.method === 'POST') return focusAgent(res, decodeURIComponent(focus[1]))

  if (pathname === '/api/version' && req.method === 'GET') return sendJson(res, 200, { version: VERSION })

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
