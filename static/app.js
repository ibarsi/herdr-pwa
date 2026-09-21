import { classifyLine } from './lines.js'

const $ = (id) => document.getElementById(id)

const LIST_POLL_MS = 3000
const FEED_POLL_MS = 2000

const state = {
  agent: null, // the agent being viewed, or null on the list
  source: 'recent', // scrollback by default; the screen alone has nothing to scroll
  hash: null,
  timer: null,
}

/**
 * Paints the feed one line at a time.
 *
 * Still textContent per line, never innerHTML — this is terminal output and a
 * pane title or a file name in it may contain anything. Plain lines stay bare
 * text nodes rather than spans: they are the majority, and wrapping them would
 * multiply the node count of a 1000-line feed to no visible end.
 */
function renderFeed(feed, text) {
  const frag = document.createDocumentFragment()
  for (const line of text.split('\n')) {
    const cls = classifyLine(line)
    if (!cls) {
      frag.append(`${line}\n`)
      continue
    }
    const span = document.createElement('span')
    span.className = `l-${cls}`
    span.textContent = `${line}\n`
    frag.append(span)
  }
  feed.textContent = ''
  feed.append(frag)
}

/** Status drives the subtitle and the header's accent colour together. */
function setFeedStatus(status) {
  state.agent.status = status
  $('feed-view').dataset.status = status
  $('feed-sub').textContent = `${state.agent.agent} · ${state.agent.dir} · ${status}`
}

/** Labels the toggle with the source it switches *to*. */
function setSourceLabel(showing) {
  $('toggle-source').textContent = showing === 'recent' ? 'screen' : 'scrollback'
}

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error?.message ?? `request failed (${res.status})`)
  return body
}

function showError(message) {
  $('error-bar').textContent = message
  $('error-bar').hidden = !message
}

async function showVersion() {
  try {
    const { version } = await api('/api/version')
    $('version').textContent = `v${version}`
  } catch {
    // A debugging aid, not a feature. Never let it block the agent list.
  }
}

/** Applies Herdr's current theme as CSS custom properties. */
async function applyTheme() {
  try {
    const { colors } = await api('/api/theme')
    for (const [token, value] of Object.entries(colors)) {
      // A null token means "terminal default", which a browser has no value
      // for; panel_bg is the closest honest substitute.
      if (value) document.documentElement.style.setProperty(`--${token.replaceAll('_', '-')}`, value)
    }
    if (colors.panel_bg) {
      document.querySelector('meta[name=theme-color]').setAttribute('content', colors.panel_bg)
    }
  } catch {
    // The built-in catppuccin defaults in the stylesheet already cover this.
  }
}

function renderList(agents) {
  const list = $('agent-list')
  list.textContent = ''

  if (agents.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No agents running'
    list.append(empty)
  }

  for (const agent of agents) {
    const row = document.createElement('button')
    row.className = 'row'
    row.onclick = () => showFeed(agent)

    const dot = document.createElement('span')
    dot.className = `dot s-${agent.status}`

    const body = document.createElement('span')
    body.className = 'grow truncate'
    const title = document.createElement('div')
    title.className = 'title truncate'
    // textContent, never innerHTML: titles come from terminal window titles.
    title.textContent = agent.title
    const dir = document.createElement('div')
    dir.className = 'dir truncate'
    dir.textContent = `${agent.agent} · ${agent.dir}`
    body.append(title, dir)

    const status = document.createElement('span')
    status.className = 'status'
    status.textContent = agent.status

    row.append(dot, body, status)
    list.append(row)
  }

  const blocked = agents.filter((a) => a.status === 'blocked').length
  $('blocked-pill').textContent = String(blocked)
  $('blocked-pill').hidden = blocked === 0
}

async function pollList() {
  try {
    const { agents } = await api('/api/agents')
    renderList(agents)
    showError('')
  } catch (err) {
    showError(err.message.includes('herdr') ? "Herdr isn't running" : err.message)
  }
}

/** Runs `fn` now and every `ms`, replacing whatever poll was running. */
function startPolling(fn, ms) {
  clearInterval(state.timer)
  fn()
  state.timer = setInterval(fn, ms)
}

export function showList() {
  state.agent = null
  $('feed-view').classList.remove('active')
  $('list-view').classList.add('active')
  startPolling(pollList, LIST_POLL_MS)
}

// Mirrors KEY_PALETTE in server.js. Labels are what fits on a phone.
const KEYS = [
  ['1', '1'], ['2', '2'], ['3', '3'],
  ['y', 'y'], ['n', 'n'],
  ['enter', '⏎'], ['esc', 'esc'],
  ['up', '↑'], ['down', '↓'],
  ['tab', '⇥'], ['shift+tab', '⇤'],
  ['ctrl+c', '^C'],
]

/** True when the user is reading scrollback rather than following the tail. */
function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

async function pollFeed() {
  if (!state.agent) return
  const pane = encodeURIComponent(state.agent.pane_id)
  const query = new URLSearchParams({ source: state.source })
  if (state.hash) query.set('h', state.hash)

  try {
    const body = await api(`/api/agents/${pane}/feed?${query}`)
    showError('')

    if (body.status && body.status !== state.agent.status) setFeedStatus(body.status)

    // The server downgrades to the screen when a working agent has no
    // capturable history, so the label follows the answer, not the request.
    if (body.source) setSourceLabel(body.source)

    if (body.unchanged) return

    const feed = $('feed')
    const follow = atBottom(feed)
    renderFeed(feed, body.text)
    state.hash = body.hash
    // Only snap to the tail if the user was already there; otherwise they are
    // reading something and yanking the scroll away is infuriating.
    if (follow) feed.scrollTop = feed.scrollHeight
  } catch (err) {
    if (err.message.includes('no longer running')) {
      showList()
      showError('That agent has ended')
      return
    }
    showError(err.message)
  }
}

export function showFeed(agent) {
  state.agent = { ...agent }
  state.source = 'recent'
  state.hash = null

  $('feed-title').textContent = agent.title
  setFeedStatus(agent.status)
  $('feed').textContent = ''
  setSourceLabel(state.source)

  $('list-view').classList.remove('active')
  $('feed-view').classList.add('active')
  startPolling(pollFeed, FEED_POLL_MS)
}

/** Sends, then polls immediately so the reply appears without waiting 2s. */
async function withRefresh(fn) {
  try {
    await fn()
    state.hash = null
    await pollFeed()
  } catch (err) {
    showError(err.message)
  }
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

$('back').onclick = () => showList()

$('toggle-source').onclick = () => {
  state.source = state.source === 'visible' ? 'recent' : 'visible'
  state.hash = null
  setSourceLabel(state.source)
  pollFeed()
}

$('focus-btn').onclick = () =>
  withRefresh(() => postJson(`/api/agents/${encodeURIComponent(state.agent.pane_id)}/focus`, {}))

for (const [key, label] of KEYS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.onclick = () =>
    withRefresh(() =>
      postJson(`/api/agents/${encodeURIComponent(state.agent.pane_id)}/keys`, { keys: [key] })
    )
  $('keys').append(button)
}

const input = $('text')

input.addEventListener('input', () => {
  $('send').disabled = input.value.trim() === ''
  // Grow with the content; the CSS max-height caps it.
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
})

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text) return

  $('send').disabled = true
  // Cleared optimistically: a reply that survives in the box after a send looks
  // like a failure, and the feed poll is the real confirmation either way.
  input.value = ''
  input.style.height = 'auto'

  await withRefresh(() =>
    postJson(`/api/agents/${encodeURIComponent(state.agent.pane_id)}/send`, { text })
  )
})

// Polling stops when the app is backgrounded: on iOS the timers are throttled
// to uselessness anyway, and every wasted request is battery.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return clearInterval(state.timer)
  if (state.agent) startPolling(pollFeed, FEED_POLL_MS)
  else startPolling(pollList, LIST_POLL_MS)
})

applyTheme()
showVersion()
showList()

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('sw registration failed', err))
}
