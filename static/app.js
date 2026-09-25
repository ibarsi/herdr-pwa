import { classifyLine, diffLines } from './lines.js'

const $ = (id) => document.getElementById(id)

const state = {
  agent: null, // the agent being viewed, or null on the list
  source: 'recent', // scrollback by default; the screen alone has nothing to scroll
  lines: [], // what the feed is showing, one DOM node per line
  stream: null, // the one open EventSource
}

/**
 * One line as one DOM node, so the feed can be edited line by line.
 *
 * Still textContent, never innerHTML — this is terminal output and a pane title
 * or a file name in it may contain anything. Plain lines stay bare text nodes
 * rather than spans: they are the majority, and wrapping them would multiply
 * the node count of a 1000-line feed to no visible end.
 */
function lineNode(line) {
  const cls = classifyLine(line)
  if (!cls) return `${line}\n`
  const span = document.createElement('span')
  span.className = `l-${cls}`
  span.textContent = `${line}\n`
  return span
}

/**
 * Paints `lines` over what is on screen, touching only what changed.
 *
 * A reader scrolled up keeps their place: lines that slide off the top of the
 * 1000-line window take their height with them, and the scroll position moves
 * back by exactly that much. Only a reader already at the bottom follows the tail.
 */
function paintFeed(feed, lines) {
  const { drop, keep, append } = diffLines(state.lines, lines)
  const follow = atBottom(feed)
  const top = feed.scrollTop
  const before = feed.scrollHeight
  for (let i = 0; i < drop; i++) feed.firstChild.remove()
  const shift = before - feed.scrollHeight
  while (feed.childNodes.length > keep) feed.lastChild.remove()
  const frag = document.createDocumentFragment()
  frag.append(...append.map(lineNode))
  feed.append(frag)
  state.lines = lines
  feed.scrollTop = follow ? feed.scrollHeight : top - shift
}

function clearFeed() {
  $('feed').textContent = ''
  state.lines = []
}

/**
 * Opens `url` as the one live stream, closing whatever was open, and routes its
 * named events to `handlers`. A closed EventSource delivers nothing, so a feed
 * left with Back can never paint over the list.
 */
function listen(url, handlers, onLost) {
  state.stream?.close()
  const stream = new EventSource(url)
  for (const [event, fn] of Object.entries(handlers)) {
    stream.addEventListener(event, (e) => fn(JSON.parse(e.data)))
  }
  // The browser reconnects on its own; this only says so meanwhile.
  stream.addEventListener('error', onLost)
  state.stream = stream
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

/** Latest event wins, so a restored Herdr turns a red light green again. */
export function paintHerdrLink(el, up) {
  el.dataset.state = up ? 'up' : 'down'
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
}

const LOST = 'Connection lost, reconnecting…'

function openList() {
  const down = (message) => {
    paintHerdrLink($('herdr-light'), false)
    showError(message)
  }
  listen(
    '/api/stream',
    {
      agents: ({ agents }) => {
        renderList(agents)
        showError('')
        paintHerdrLink($('herdr-light'), true)
      },
      down: ({ message }) => down(message.includes('herdr') ? "Herdr isn't running" : message),
    },
    () => down(LOST)
  )
}

export function showList() {
  state.agent = null
  $('feed-view').classList.remove('active')
  $('list-view').classList.add('active')
  openList()
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

function openFeed() {
  listen(
    `/api/agents/${encodeURIComponent(state.agent.pane_id)}/stream?source=${state.source}`,
    {
      status: ({ status }) => setFeedStatus(status),
      feed: ({ text, source }) => {
        showError('')
        // The server downgrades to the screen when a working agent has no
        // capturable history, so the label follows the answer, not the request.
        setSourceLabel(source)
        paintFeed($('feed'), text.split('\n'))
      },
      gone: () => {
        showList()
        showError('That agent has ended')
      },
      down: ({ message }) => showError(message),
    },
    () => showError(LOST)
  )
}

export function showFeed(agent) {
  state.agent = { ...agent }
  state.source = 'recent'

  $('feed-title').textContent = agent.title
  setFeedStatus(agent.status)
  clearFeed()
  setSourceLabel(state.source)

  $('list-view').classList.remove('active')
  $('feed-view').classList.add('active')
  openFeed()
}

/** The stream shows the result; the server wakes the feed on any input. */
async function act(fn) {
  try {
    await fn()
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

if (typeof document !== 'undefined') {
  $('back').onclick = () => showList()

  $('toggle-source').onclick = () => {
    state.source = state.source === 'visible' ? 'recent' : 'visible'
    clearFeed()
    setSourceLabel(state.source)
    openFeed()
  }

  $('focus-btn').onclick = () =>
    act(() => postJson(`/api/agents/${encodeURIComponent(state.agent.pane_id)}/focus`, {}))

  for (const [key, label] of KEYS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.onclick = () =>
      act(() =>
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
    // like a failure, and the feed stream is the real confirmation either way.
    input.value = ''
    input.style.height = 'auto'

    await act(() =>
      postJson(`/api/agents/${encodeURIComponent(state.agent.pane_id)}/send`, { text })
    )
  })

  // The stream closes when the app is backgrounded: iOS suspends it anyway, and
  // while it is open the server keeps reading Herdr for it. Reopening repaints
  // through the same diff, so a reader scrolled up keeps their place.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.stream?.close()
      state.stream = null
    } else if (state.agent) openFeed()
    else openList()
  })

  applyTheme()
  showVersion()
  showList()

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('sw registration failed', err))
  }
}
