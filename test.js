import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { herdr, HerdrError } from './herdr.js'
import { cleanFeed, hashFeed } from './feed.js'
import { parseColor, resolveTheme, loadTheme } from './theme.js'
import { createServer } from './server.js'
import { classifyLine, diffLines } from './static/lines.js'
import {
  parseSubject, parseCommits, bumpLevel, nextVersion, renderChangelog, readNotes,
} from './tools/release.js'

let sockSeq = 0

/**
 * Stands up a fake Herdr speaking NDJSON on a Unix socket.
 * `handler(req)` returns the object merged into `{id}` for the response,
 * e.g. `{result: {...}}` or `{error: {code, message}}`. Returning
 * `undefined` sends nothing, which exercises the timeout path.
 * Returns `{path, calls, push, close}` — `calls` accumulates every parsed
 * request, and `push(msg)` writes an event to every open subscription.
 */
async function fakeHerdr(handler) {
  const path = join(tmpdir(), `herdr-test-${process.pid}-${sockSeq++}.sock`)
  const calls = []
  const sockets = new Set()
  const subscribers = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => {
      sockets.delete(sock)
      subscribers.delete(sock)
    })
    sock.on('error', () => {})
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        calls.push(req)
        if (req.method === 'events.subscribe') subscribers.add(sock)
        const res = handler(req)
        if (res !== undefined) sock.write(JSON.stringify({ id: req.id, ...res }) + '\n')
      }
    })
  })
  await new Promise((resolve) => server.listen(path, resolve))
  return {
    path,
    calls,
    push: (msg) => {
      for (const s of subscribers) s.write(JSON.stringify(msg) + '\n')
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(resolve)
      }),
  }
}

test('herdr sends the method and params and returns result', async () => {
  const fake = await fakeHerdr((req) => ({ result: { type: 'agent_list', agents: [{ pane_id: 'w1:p1' }] } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  try {
    const result = await herdr('agent.list', {})
    assert.deepEqual(result.agents, [{ pane_id: 'w1:p1' }])
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].method, 'agent.list')
    assert.ok(fake.calls[0].id, 'request carries an id')
  } finally {
    await fake.close()
  }
})

test('herdr refuses a method outside the allowlist without opening a socket', async () => {
  const fake = await fakeHerdr(() => ({ result: {} }))
  process.env.HERDR_SOCKET_PATH = fake.path
  try {
    await assert.rejects(() => herdr('pane.split', { argv: ['sh'] }), (e) => {
      assert.ok(e instanceof HerdrError)
      assert.equal(e.code, 'method_not_allowed')
      return true
    })
    assert.equal(fake.calls.length, 0, 'nothing was written to the socket')
  } finally {
    await fake.close()
  }
})

test('herdr turns a Herdr error response into a HerdrError with its code', async () => {
  const fake = await fakeHerdr(() => ({ error: { code: 'agent_not_found', message: 'no such agent' } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  try {
    await assert.rejects(() => herdr('agent.focus', { target: 'w9:p9' }), (e) => {
      assert.equal(e.code, 'agent_not_found')
      assert.equal(e.message, 'no such agent')
      return true
    })
  } finally {
    await fake.close()
  }
})

test('herdr reports a missing socket as socket_unavailable', async () => {
  process.env.HERDR_SOCKET_PATH = join(tmpdir(), 'herdr-test-does-not-exist.sock')
  await assert.rejects(() => herdr('agent.list', {}), (e) => {
    assert.equal(e.code, 'socket_unavailable')
    return true
  })
})

test('herdr times out when Herdr never answers', async () => {
  const fake = await fakeHerdr(() => undefined)
  process.env.HERDR_SOCKET_PATH = fake.path
  try {
    await assert.rejects(() => herdr('agent.list', {}, { timeout: 50 }), (e) => {
      assert.equal(e.code, 'timeout')
      return true
    })
  } finally {
    await fake.close()
  }
})

test('cleanFeed drops long rule lines and keeps footer text', () => {
  const input = [
    'Here is some output.',
    '────────────────────────────────────────',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '--------------------',
    'Opus 5 - herdr-pwa - master - 65%',
  ].join('\n')
  assert.equal(cleanFeed(input), 'Here is some output.\nOpus 5 - herdr-pwa - master - 65%')
})

test('cleanFeed keeps short rules and rules mixed with text', () => {
  const input = ['-----', 'a ──────────────────────────── b'].join('\n')
  assert.equal(cleanFeed(input), input)
})

test('cleanFeed collapses blank runs and right-strips lines', () => {
  assert.equal(cleanFeed('a   \n\n\n\nb\t\n'), 'a\n\nb')
})

test('hashFeed is stable, short, and url-safe', () => {
  const h = hashFeed('hello')
  assert.equal(h.length, 16)
  assert.match(h, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(h, hashFeed('hello'))
  assert.notEqual(h, hashFeed('hello '))
})

test('parseColor handles every form Herdr accepts', () => {
  assert.equal(parseColor('#89b4fa'), '#89b4fa')
  assert.equal(parseColor('#ABC'), '#aabbcc')
  assert.equal(parseColor('rgb(137, 180, 250)'), '#89b4fa')
  assert.equal(parseColor('black'), '#000000')
  assert.equal(parseColor('DarkGrey'), '#7f7f7f')
  assert.equal(parseColor('reset'), null)
  assert.equal(parseColor('transparent'), null)
  assert.equal(parseColor('wat'), '#00cdcd') // Herdr's own unknown-colour fallback
})

test('resolveTheme returns the named palette', () => {
  const { name, colors } = resolveTheme('[theme]\nname = "dracula"\n')
  assert.equal(name, 'dracula')
  assert.equal(Object.keys(colors).length, 19)
  assert.match(colors.text, /^#[0-9a-f]{6}$/)
})

test('resolveTheme applies theme.custom over the base palette', () => {
  const base = resolveTheme('[theme]\nname = "catppuccin"\n').colors
  const { colors } = resolveTheme(
    '[theme]\n# a comment\nname = "catppuccin"\nauto_switch = false\n[theme.custom]\npanel_bg = "black"\n'
  )
  assert.equal(colors.panel_bg, '#000000')
  assert.equal(colors.text, base.text, 'untouched tokens keep the base value')
})

test('resolveTheme stops reading custom at the next section', () => {
  const { colors } = resolveTheme(
    '[theme]\nname = "catppuccin"\n[theme.custom]\naccent = "#ff0000"\n[ui]\naccent = "blue"\n'
  )
  assert.equal(colors.accent, '#ff0000')
})

test('resolveTheme maps the terminal theme onto catppuccin', () => {
  const { name, colors } = resolveTheme('[theme]\nname = "terminal"\n')
  assert.equal(name, 'catppuccin')
  assert.equal(colors.text, resolveTheme('[theme]\nname = "catppuccin"\n').colors.text)
})

test('resolveTheme understands Herdr name aliases and unknown names', () => {
  assert.equal(resolveTheme('[theme]\nname = "tokyonight"\n').name, 'tokyo-night')
  assert.equal(resolveTheme('[theme]\nname = "catppuccin_latte"\n').name, 'catppuccin-latte')
  assert.equal(resolveTheme('[theme]\nname = "nonsense"\n').name, 'catppuccin')
  assert.equal(resolveTheme('').name, 'catppuccin')
})

test('resolveTheme preserves reset tokens as null', () => {
  assert.equal(resolveTheme('[theme]\nname = "catppuccin"\n').colors.sidebar_bg, null)
})

test('loadTheme falls back to catppuccin when the config is unreadable', () => {
  process.env.HERDR_CONFIG_PATH = join(tmpdir(), 'herdr-test-no-such-config.toml')
  assert.equal(loadTheme().name, 'catppuccin')
})

test('loadTheme reads the configured file', () => {
  const path = join(tmpdir(), `herdr-test-config-${process.pid}.toml`)
  writeFileSync(path, '[theme]\nname = "nord"\n')
  process.env.HERDR_CONFIG_PATH = path
  assert.equal(loadTheme().name, 'nord')
})

test('classifyLine reads the glyphs claude and grok actually print', () => {
  // Samples taken verbatim from live panes.
  const cases = [
    ['❯ commit and push', 'you'],
    ['● Pushed. beb31a7..352a656 on origin/main', 'head'],
    ['  ⎿ ran 1 shell command', 'aux'],
    ['◆ Thought for 2.4s', 'head'],
    ['┃ The user wants me to continue the /ship process', 'dim'],
    ['✻ Cooked for 3m 23s · done 6:14 PM', 'dim'],
    ['$ git rev-parse --abbrev-ref HEAD', 'cmd'],
    ['  … +12 lines', 'dim'],
    ['  │ migration-cohorts (idle) │ 996 │', 'aux'],
    ['Reading the failing activity and test sites.', ''],
    ['', ''],
  ]
  for (const [line, expected] of cases) {
    assert.equal(classifyLine(line), expected, JSON.stringify(line))
  }
})

test('diffLines always rebuilds next, and keeps what survived in place', () => {
  const apply = (prev, { drop, keep, append }) => [...prev.slice(drop, drop + keep), ...append]
  const cases = [
    // [prev, next, expected {drop, keep}]
    [[], ['a', 'b'], { drop: 0, keep: 0 }],
    [['a', 'b'], ['a', 'b', 'c'], { drop: 0, keep: 2 }], // plain append
    [['a', 'b', 'c'], ['b', 'c', 'd'], { drop: 1, keep: 2 }], // the 1000-line window slid
    [['a', 'b', 'footer 1%'], ['a', 'b', 'c', 'footer 2%'], { drop: 0, keep: 2 }], // footer redrawn
    [['a', 'b'], ['x', 'y'], { drop: 2, keep: 0 }], // a screen redraw shares nothing
    [['', 'a', '', 'b'], ['', 'b', 'c'], { drop: 2, keep: 2 }], // blank lines do not mislead it
  ]
  for (const [prev, next, expected] of cases) {
    const diff = diffLines(prev, next)
    assert.deepEqual(apply(prev, diff), next, JSON.stringify({ prev, next }))
    assert.deepEqual({ drop: diff.drop, keep: diff.keep }, expected, JSON.stringify({ prev, next }))
  }
})

test('leaving a feed closes its stream and opens the list stream', () => {
  const script = join(tmpdir(), `herdr-feed-streams-${process.pid}.mjs`)
  writeFileSync(script, `
    function el() {
      const names = new Set()
      return {
        hidden: false,
        textContent: '',
        value: '',
        disabled: false,
        dataset: {},
        style: {},
        classList: {
          add(name) { names.add(name) },
          remove(name) { names.delete(name) },
          contains(name) { return names.has(name) },
        },
        append() {},
        addEventListener() {},
        setAttribute() {},
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
      }
    }
    const nodes = new Map()
    const node = (id) => {
      if (!nodes.has(id)) nodes.set(id, el())
      return nodes.get(id)
    }
    globalThis.document = {
      hidden: false,
      documentElement: { style: { setProperty() {} } },
      getElementById: node,
      createElement: el,
      createDocumentFragment: () => ({ append() {} }),
      querySelector: () => ({ setAttribute() {} }),
      addEventListener() {},
    }
    const opened = []
    globalThis.EventSource = class {
      constructor(url) { this.url = url; this.closed = false; opened.push(this) }
      addEventListener() {}
      close() { this.closed = true }
    }
    globalThis.fetch = (path) => Promise.resolve({ ok: true, status: 200, json: async () => ({ version: '0.0.0', colors: {} }) })
    const { showFeed, showList } = await import(${JSON.stringify(new URL('./static/app.js', import.meta.url).href)})
    showFeed({ pane_id: 'w1:p1', title: 'grok', status: 'idle', agent: 'grok', dir: 'proj' })
    const feed = opened.at(-1)
    if (feed.url !== '/api/agents/w1%3Ap1/stream?source=recent') throw new Error('feed stream url ' + feed.url)
    showList()
    if (!feed.closed) throw new Error('the feed stream was left open after Back')
    if (opened.at(-1).url !== '/api/stream') throw new Error('the list stream was not reopened')
    if (opened.filter((s) => !s.closed).length !== 1) throw new Error('more than one stream open')
    process.exit(0)
  `)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('herdr link light returns to green after the connection comes back', async () => {
  const { paintHerdrLink } = await import('./static/app.js')
  const el = { dataset: {} }
  paintHerdrLink(el, true)
  assert.equal(el.dataset.state, 'up')
  paintHerdrLink(el, false)
  assert.equal(el.dataset.state, 'down')
  paintHerdrLink(el, true)
  assert.equal(el.dataset.state, 'up')
})

test('classifyLine flags failures without reddening prose that mentions them', () => {
  assert.equal(classifyLine('FAIL: 3 tests failed'), 'bad')
  assert.equal(classifyLine('  ✗ assertion failed'), 'bad')
  assert.equal(classifyLine('  ⎿ Error: connection refused'), 'bad')

  // The words appear mid-sentence constantly; only line-start markers count.
  assert.equal(classifyLine('● That error is handled by the retry path'), 'head')
  assert.equal(classifyLine('Added error handling to the parser'), '')
  // Your own turn keeps its colour even when you are reporting a failure.
  assert.equal(classifyLine('❯ fix the failing test'), 'you')
})

/** Starts the adapter on an ephemeral port. Returns `{url, close}`. */
async function startServer() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    // Open streams would otherwise hold close() forever.
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      }),
  }
}

const AUTH = { 'Tailscale-User-Login': 'user@example.com' }

const AGENT_LIST = {
  result: {
    type: 'agent_list',
    agents: [
      {
        pane_id: 'w1:p1',
        agent: 'claude',
        agent_status: 'idle',
        cwd: '/home/user/project',
        workspace_id: 'w1',
        terminal_title: 'raw title',
        terminal_title_stripped: 'Nice Title',
        state_change_seq: 7,
        unknown_future_field: 'ignored',
      },
      {
        pane_id: 'w2:p3',
        agent: 'grok',
        agent_status: 'blocked',
        cwd: '/home/user/herdr-pwa',
        workspace_id: 'w2',
        state_change_seq: 9,
      },
    ],
  },
}

const WORKSPACE_LIST = {
  result: {
    type: 'workspace_list',
    workspaces: [
      { workspace_id: 'w1', label: 'the-space-name' },
      { workspace_id: 'w9', label: 'some-other-space' },
    ],
  },
}

/** Answers agent.list and workspace.list; anything else falls to `rest`. */
const herdrFixture =
  (rest = () => ({ result: { type: 'ok' } })) =>
  (req) =>
    req.method === 'agent.list'
      ? AGENT_LIST
      : req.method === 'workspace.list'
        ? WORKSPACE_LIST
        : rest(req)

test('a request without the Tailscale identity header is rejected', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  delete process.env.DEV_BYPASS_AUTH
  const app = await startServer()
  try {
    assert.equal((await fetch(`${app.url}/api/agents`)).status, 403)
    const wrong = await fetch(`${app.url}/api/agents`, {
      headers: { 'Tailscale-User-Login': 'someone@else.com' },
    })
    assert.equal(wrong.status, 403)
    assert.equal(fake.calls.length, 0, 'an unauthenticated request never reaches herdr')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('unset ALLOWED_LOGIN fails closed and never touches the socket', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  delete process.env.ALLOWED_LOGIN
  delete process.env.DEV_BYPASS_AUTH
  const app = await startServer()
  try {
    assert.equal((await fetch(`${app.url}/api/agents`)).status, 403)
    assert.equal(fake.calls.length, 0, 'an unauthenticated request never reaches herdr')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET /api/agents titles each agent with its space and sorts the list', async () => {
  const fake = await fakeHerdr(herdrFixture())
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents`, { headers: AUTH })
    assert.equal(res.status, 200)
    const { agents } = await res.json()
    assert.equal(agents.length, 2)
    assert.equal(agents[0].pane_id, 'w2:p3', 'blocked sorts first')
    assert.equal(agents[0].title, 'grok', 'a space with no label falls back to the agent name')
    assert.deepEqual(agents[1], {
      pane_id: 'w1:p1',
      agent: 'claude',
      status: 'idle',
      title: 'the-space-name',
      cwd: '/home/user/project',
      dir: 'project',
      state_change_seq: 7,
    })
    assert.equal(fake.calls.some((c) => c.method === 'agent.list'), true)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET /api/agents still lists agents when workspace.list fails', async () => {
  const fake = await fakeHerdr((req) =>
    req.method === 'agent.list'
      ? AGENT_LIST
      : { error: { code: 'invalid_request', message: 'unknown variant `workspace.list`' } }
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents`, { headers: AUTH })
    assert.equal(res.status, 200)
    const { agents } = await res.json()
    assert.equal(agents[1].title, 'Nice Title', 'falls back to the terminal title')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('an unknown path returns 404 and never touches the socket', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    for (const p of ['/api/pane.split', '/api/nope', '/api/agents/w1:p1/split']) {
      assert.equal((await fetch(`${app.url}${p}`, { headers: AUTH })).status, 404, p)
    }
    assert.equal(fake.calls.length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('a missing Herdr socket surfaces as 503', async () => {
  process.env.HERDR_SOCKET_PATH = join(tmpdir(), 'herdr-test-absent.sock')
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents`, { headers: AUTH })
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error.code, 'socket_unavailable')
  } finally {
    await app.close()
  }
})

test('the app shell is served and also requires auth', async () => {
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    assert.equal((await fetch(`${app.url}/`)).status, 403)
    const res = await fetch(`${app.url}/`, { headers: AUTH })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
  } finally {
    await app.close()
  }
})

test('static serving cannot escape the static directory', async () => {
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/../server.js`, { headers: AUTH })
    assert.equal(res.status, 404)
  } finally {
    await app.close()
  }
})

/** Reads SSE frames off a fetch response; `next()` skips comments and returns null at the end. */
function sse(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  return {
    async next() {
      for (;;) {
        const i = buf.indexOf('\n\n')
        if (i !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const event = frame.match(/^event: (.*)$/m)?.[1]
          if (event) return { event, data: JSON.parse(frame.match(/^data: (.*)$/m)[1]) }
          continue
        }
        const { value, done } = await reader.read()
        if (done) return null
        buf += value
      }
    },
    cancel: () => reader.cancel(),
  }
}

/** Skips ahead to the next frame named `event`. */
async function until(stream, event) {
  for (let frame; (frame = await stream.next()); ) if (frame.event === event) return frame.data
  throw new Error(`stream ended before ${event}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A Herdr that answers subscriptions and whose pane text and statuses the test
 * can change underneath the adapter.
 */
async function liveHerdr({ text = 'hello', statuses = {}, read } = {}) {
  const world = { text, statuses: { 'w1:p1': 'idle', 'w2:p3': 'blocked', ...statuses } }
  const fake = await fakeHerdr((req) => {
    if (req.method === 'events.subscribe') return { result: { type: 'subscription_started' } }
    if (req.method === 'agent.list') {
      const agents = AGENT_LIST.result.agents.map((a) => ({ ...a, agent_status: world.statuses[a.pane_id] }))
      return { result: { type: 'agent_list', agents } }
    }
    if (req.method === 'workspace.list') return WORKSPACE_LIST
    if (req.method === 'agent.read') {
      return read?.(req) ?? { result: { type: 'pane_read', read: { text: world.text, truncated: false } } }
    }
    return { result: { type: 'ok' } }
  })
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const reads = () => fake.calls.filter((c) => c.method === 'agent.read')
  const status = (pane_id, agent_status) => {
    world.statuses[pane_id] = agent_status
    fake.push({ event: 'pane.agent_status_changed', data: { pane_id, agent_status, workspace_id: 'w1' } })
  }
  return { fake, world, reads, status }
}

const openFeed = async (app, pane, query = '') =>
  sse(await fetch(`${app.url}/api/agents/${pane}/stream${query}`, { headers: AUTH }))

test('the feed stream sends cleaned text and status, then nothing until it changes', async () => {
  const herdr = await liveHerdr({ text: 'hello\n────────────────────────────\nworld' })
  const app = await startServer()
  const feed = await openFeed(app, 'w2:p3')
  try {
    assert.deepEqual(await until(feed, 'status'), { status: 'blocked' })
    assert.deepEqual(await until(feed, 'feed'), { text: 'hello\nworld', source: 'recent' })

    const [read] = herdr.reads()
    assert.deepEqual(read.params, { target: 'w2:p3', source: 'recent', lines: 1000, strip_ansi: true })
    const sub = herdr.fake.calls.find((c) => c.method === 'events.subscribe')
    assert.ok(sub.params.subscriptions.some((s) => s.type === 'pane.agent_status_changed' && s.pane_id === 'w2:p3'))

    // A blocked agent keeps being read, but unchanged text is not re-sent.
    await sleep(700)
    assert.ok(herdr.reads().length >= 2)
    herdr.world.text = 'hello\nworld\nmore'
    assert.deepEqual(await feed.next(), { event: 'feed', data: { text: 'hello\nworld\nmore', source: 'recent' } })
  } finally {
    await feed.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('the feed stream falls back to the visible screen when the agent is mid-work', async () => {
  // Herdr refuses scrollback for a working alternate-screen TUI; the phone must
  // still get the screen rather than an error.
  const herdr = await liveHerdr({
    read: (req) =>
      req.params.source === 'recent'
        ? { error: { code: 'agent_not_idle', message: 'cannot read 1000 lines while w2:p3 is working' } }
        : { result: { type: 'pane_read', read: { text: 'the screen', truncated: false } } },
  })
  const app = await startServer()
  const feed = await openFeed(app, 'w2:p3')
  try {
    assert.deepEqual(await until(feed, 'feed'), { text: 'the screen', source: 'visible' })
    assert.deepEqual(herdr.reads().slice(0, 2).map((r) => r.params.source), ['recent', 'visible'])
  } finally {
    await feed.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('an explicit source=visible is honoured and not upgraded', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w2:p3', '?source=visible')
  try {
    assert.equal((await until(feed, 'feed')).source, 'visible')
    assert.equal(herdr.reads()[0].params.source, 'visible')
    assert.equal(herdr.reads()[0].params.lines, 60)
  } finally {
    await feed.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('an idle agent is read once, then again only while it works', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w1:p1')
  try {
    await until(feed, 'feed')
    await sleep(700)
    assert.equal(herdr.reads().length, 1, 'no polling while idle')

    herdr.status('w1:p1', 'working')
    assert.deepEqual(await until(feed, 'status'), { status: 'working' })
    await sleep(700)
    assert.ok(herdr.reads().length >= 3, 'reads resume while working')

    herdr.status('w1:p1', 'idle')
    await until(feed, 'status')
    await sleep(700)
    const settled = herdr.reads().length
    await sleep(700)
    assert.equal(herdr.reads().length, settled, 'reads stop again once idle')
  } finally {
    await feed.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('input to an idle agent keeps its feed reading for a moment', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w1:p1')
  try {
    await until(feed, 'feed')
    await post(`${app.url}/api/agents/w1:p1/keys`, { keys: ['esc'] })
    await sleep(700)
    assert.ok(herdr.reads().length >= 2)
  } finally {
    await feed.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('the feed stream says gone when the pane closes, then ends', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w2:p3')
  try {
    await until(feed, 'feed')
    herdr.fake.push({ event: 'pane.closed', data: { pane_id: 'w2:p3', workspace_id: 'w2' } })
    assert.equal((await feed.next()).event, 'gone')
    assert.equal(await feed.next(), null)
  } finally {
    await app.close()
    await herdr.fake.close()
  }
})

test('the feed stream for an agent that has ended says gone without reading', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w9:p9')
  try {
    assert.equal((await feed.next()).event, 'gone')
    assert.equal(herdr.reads().length, 0)
  } finally {
    await app.close()
    await herdr.fake.close()
  }
})

test('closing the feed stream stops the reads', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const feed = await openFeed(app, 'w2:p3')
  try {
    await until(feed, 'feed')
    await feed.cancel()
    await sleep(700)
    const after = herdr.reads().length
    await sleep(700)
    assert.equal(herdr.reads().length, after)
  } finally {
    await app.close()
    await herdr.fake.close()
  }
})

test('the list stream sends the agents, then again when a status changes', async () => {
  const herdr = await liveHerdr()
  const app = await startServer()
  const list = sse(await fetch(`${app.url}/api/stream`, { headers: AUTH }))
  try {
    const first = await until(list, 'agents')
    assert.deepEqual(first.agents.map((a) => [a.pane_id, a.status]), [['w2:p3', 'blocked'], ['w1:p1', 'idle']])

    const sub = herdr.fake.calls.find((c) => c.method === 'events.subscribe')
    const types = sub.params.subscriptions.map((s) => `${s.type}${s.pane_id ? ` ${s.pane_id}` : ''}`)
    for (const t of ['pane.created', 'pane.closed', 'pane.agent_status_changed w1:p1', 'pane.agent_status_changed w2:p3']) {
      assert.ok(types.includes(t), t)
    }

    herdr.status('w1:p1', 'working')
    const next = await until(list, 'agents')
    assert.deepEqual(next.agents.map((a) => [a.pane_id, a.status]), [['w2:p3', 'blocked'], ['w1:p1', 'working']])
  } finally {
    await list.cancel()
    await app.close()
    await herdr.fake.close()
  }
})

test('the list stream reports down when Herdr is not running', async () => {
  process.env.HERDR_SOCKET_PATH = join(tmpdir(), 'herdr-test-absent.sock')
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  const list = sse(await fetch(`${app.url}/api/stream`, { headers: AUTH }))
  try {
    assert.equal((await list.next()).event, 'down')
  } finally {
    await list.cancel()
    await app.close()
  }
})

test('the streams require auth like everything else', async () => {
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    assert.equal((await fetch(`${app.url}/api/stream`)).status, 403)
    assert.equal((await fetch(`${app.url}/api/agents/w1:p1/stream`)).status, 403)
  } finally {
    await app.close()
  }
})

/** POSTs JSON to the adapter with the identity header attached. */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('send to a blocked agent uses pane.send_input with enter', async () => {
  const fake = await fakeHerdr((req) => (req.method === 'agent.list' ? AGENT_LIST : { result: { type: 'ok' } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w2:p3/send`, { text: 'yes' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).via, 'pane.send_input')
    assert.equal(fake.calls.filter((c) => c.method === 'agent.prompt').length, 0)
    const sent = fake.calls.find((c) => c.method === 'pane.send_input')
    assert.deepEqual(sent.params, { pane_id: 'w2:p3', text: 'yes', keys: ['enter'] })
  } finally {
    await app.close()
    await fake.close()
  }
})

test('send to an idle agent uses agent.prompt', async () => {
  const fake = await fakeHerdr((req) => (req.method === 'agent.list' ? AGENT_LIST : { result: { type: 'ok' } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w1:p1/send`, { text: 'run the tests' })
    assert.equal((await res.json()).via, 'agent.prompt')
    const sent = fake.calls.find((c) => c.method === 'agent.prompt')
    assert.deepEqual(sent.params, { target: 'w1:p1', text: 'run the tests' })
    assert.equal(fake.calls.filter((c) => c.method === 'pane.send_input').length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('send retries via pane.send_input when the agent blocks mid-flight', async () => {
  const fake = await fakeHerdr((req) => {
    if (req.method === 'agent.list') return AGENT_LIST
    if (req.method === 'agent.prompt')
      return { error: { code: 'agent_blocked', message: 'agent w1:p1 is blocked' } }
    return { result: { type: 'ok' } }
  })
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w1:p1/send`, { text: 'ok' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).via, 'pane.send_input')
    const retry = fake.calls.find((c) => c.method === 'pane.send_input')
    assert.deepEqual(retry.params, { pane_id: 'w1:p1', text: 'ok', keys: ['enter'] })
  } finally {
    await app.close()
    await fake.close()
  }
})

test('send surfaces a non-blocked prompt error rather than retrying', async () => {
  const fake = await fakeHerdr((req) => {
    if (req.method === 'agent.list') return AGENT_LIST
    return { error: { code: 'agent_not_ready', message: 'still starting' } }
  })
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w1:p1/send`, { text: 'ok' })
    assert.equal(res.status, 409)
    assert.equal(fake.calls.filter((c) => c.method === 'pane.send_input').length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('send to a pane absent from agent.list is 404 and writes nothing', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w9:p9/send`, { text: 'hello' })
    assert.equal(res.status, 404)
    assert.equal(fake.calls.every((c) => c.method === 'agent.list'), true)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('send rejects empty text before opening a socket', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    for (const body of [{ text: '' }, { text: '   \n' }, {}]) {
      const res = await post(`${app.url}/api/agents/w1:p1/send`, body)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal(fake.calls.length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('keys sends the palette keys through pane.send_input', async () => {
  const fake = await fakeHerdr((req) => (req.method === 'agent.list' ? AGENT_LIST : { result: { type: 'ok' } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await post(`${app.url}/api/agents/w2:p3/keys`, { keys: ['down', 'enter'] })
    assert.equal(res.status, 200)
    const sent = fake.calls.find((c) => c.method === 'pane.send_input')
    assert.deepEqual(sent.params, { pane_id: 'w2:p3', keys: ['down', 'enter'] })
  } finally {
    await app.close()
    await fake.close()
  }
})

test('keys outside the palette are rejected without touching the socket', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    for (const keys of [['ctrl+alt+delete'], [], ['enter', 'f1'], 'enter']) {
      const res = await post(`${app.url}/api/agents/w2:p3/keys`, { keys })
      assert.equal(res.status, 400, JSON.stringify(keys))
    }
    assert.equal(fake.calls.length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('focus calls agent.focus for a live agent', async () => {
  const fake = await fakeHerdr((req) => (req.method === 'agent.list' ? AGENT_LIST : { result: { type: 'ok' } }))
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    assert.equal((await post(`${app.url}/api/agents/w1:p1/focus`, {})).status, 200)
    assert.deepEqual(fake.calls.find((c) => c.method === 'agent.focus').params, { target: 'w1:p1' })
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET /api/theme serves the resolved palette and never touches the socket', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const path = join(tmpdir(), `herdr-test-theme-${process.pid}.toml`)
  writeFileSync(path, '[theme]\nname = "catppuccin"\n[theme.custom]\npanel_bg = "black"\n')
  process.env.HERDR_CONFIG_PATH = path
  const app = await startServer()
  try {
    const body = await (await fetch(`${app.url}/api/theme`, { headers: AUTH })).json()
    assert.equal(body.name, 'catppuccin')
    assert.equal(body.colors.panel_bg, '#000000')
    assert.equal(body.colors.text, '#cdd6f4')
    assert.equal(fake.calls.length, 0)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('parseSubject reads type, scope, description and the breaking marker', () => {
  assert.deepEqual(parseSubject('feat: add a thing'), {
    type: 'feat', scope: null, description: 'add a thing', breaking: false,
  })
  assert.deepEqual(parseSubject('fix(server): stop the leak'), {
    type: 'fix', scope: 'server', description: 'stop the leak', breaking: false,
  })
  assert.deepEqual(parseSubject('feat(api)!: drop the v1 route'), {
    type: 'feat', scope: 'api', description: 'drop the v1 route', breaking: true,
  })
})

test('parseSubject rejects anything outside the conventional grammar', () => {
  assert.equal(parseSubject('wip'), null)
  assert.equal(parseSubject('Update server.js'), null)
  // A plausible-looking type that is not on the list is still a rejection,
  // or CI would accept titles the changelog then silently drops.
  assert.equal(parseSubject('wibble: something'), null)
  assert.equal(parseSubject('feat:no space after the colon'), null)
})

test('parseCommits splits the git log record format and collects rejects', () => {
  const raw = 'feat: one\x00\x1e\nfix(ui): two\x00body text\x1e\nnonsense here\x00\x1e'
  const { commits, unparsed } = parseCommits(raw)
  assert.deepEqual(commits.map((c) => c.description), ['one', 'two'])
  assert.equal(commits[1].scope, 'ui')
  assert.deepEqual(unparsed, ['nonsense here'])
})

test('parseCommits treats a BREAKING CHANGE footer as breaking', () => {
  const raw = 'feat: one\x00BREAKING CHANGE: the socket path moved\x1e'
  const { commits } = parseCommits(raw)
  assert.equal(commits[0].breaking, true)
  // The hyphenated spelling is equally valid per the convention.
  const { commits: hyphen } = parseCommits('feat: one\x00BREAKING-CHANGE: moved\x1e')
  assert.equal(hyphen[0].breaking, true)
})

test('bumpLevel reports intent, before any pre-1.0 rule is applied', () => {
  const c = (type, breaking = false) => ({ type, scope: null, description: 'x', breaking })
  assert.equal(bumpLevel([c('feat', true), c('fix')]), 'major')
  assert.equal(bumpLevel([c('feat'), c('fix')]), 'minor')
  assert.equal(bumpLevel([c('fix'), c('docs')]), 'patch')
  assert.equal(bumpLevel([c('chore'), c('docs')]), null)
  assert.equal(bumpLevel([]), null)
})

test('nextVersion keeps a breaking change inside 0.x', () => {
  // Reaching 1.0.0 must be a decision, never a side effect of a feat!.
  assert.equal(nextVersion('0.1.0', 'major'), '0.2.0')
  assert.equal(nextVersion('0.1.0', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.3', 'patch'), '0.1.4')
  assert.equal(nextVersion('0.0.0', 'minor'), '0.1.0')
})

test('nextVersion applies ordinary semver at 1.0.0 and above', () => {
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0')
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0')
  assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3')
})

test('nextVersion returns null when there is nothing to release', () => {
  assert.equal(nextVersion('0.1.0', null), null)
})

test('renderChangelog groups by type and labels scopes', () => {
  const commits = [
    { type: 'feat', scope: null, description: 'add a thing', breaking: false },
    { type: 'feat', scope: 'ui', description: 'add another', breaking: false },
    { type: 'fix', scope: null, description: 'stop the leak', breaking: false },
    { type: 'chore', scope: null, description: 'tidy up', breaking: false },
  ]
  const out = renderChangelog('0.2.0', '2026-09-21', commits)
  assert.match(out, /^## 0\.2\.0 \(2026-09-21\)/)
  assert.match(out, /### Features\n\n- add a thing\n- \*\*ui:\*\* add another/)
  assert.match(out, /### Fixes\n\n- stop the leak/)
  assert.match(out, /### Chores\n\n- tidy up/)
})

test('renderChangelog leads with a breaking changes section', () => {
  const commits = [
    { type: 'fix', scope: null, description: 'a fix', breaking: false },
    { type: 'feat', scope: 'api', description: 'drop the v1 route', breaking: true },
  ]
  const out = renderChangelog('0.3.0', '2026-09-21', commits)
  assert.ok(out.indexOf('### Breaking changes') < out.indexOf('### Features'))
  // A breaking feat appears in both sections, so neither reads as incomplete.
  assert.equal(out.match(/drop the v1 route/g).length, 2)
})

test('renderChangelog omits sections with no commits', () => {
  const out = renderChangelog('0.1.1', '2026-09-21', [
    { type: 'fix', scope: null, description: 'only a fix', breaking: false },
  ])
  assert.doesNotMatch(out, /### Features/)
  assert.doesNotMatch(out, /### Breaking changes/)
})

test('readNotes returns one version section without its heading', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 0.2.0 (2026-09-21)',
    '',
    '### Features',
    '',
    '- the new one',
    '',
    '## 0.1.0 (2026-09-01)',
    '',
    '### Features',
    '',
    '- the old one',
    '',
  ].join('\n')
  const notes = readNotes(changelog, '0.2.0')
  assert.match(notes, /- the new one/)
  assert.doesNotMatch(notes, /the old one/)
  assert.doesNotMatch(notes, /^## /)
  // The oldest section runs to end-of-file rather than to the next heading.
  assert.match(readNotes(changelog, '0.1.0'), /- the old one/)
  assert.equal(readNotes(changelog, '9.9.9'), null)
})

test('GET /api/version reports the running version without touching the socket', async () => {
  process.env.ALLOWED_LOGIN = 'user@example.com'
  delete process.env.DEV_BYPASS_AUTH
  const app = await startServer()
  try {
    assert.equal((await fetch(`${app.url}/api/version`)).status, 403)
    const res = await fetch(`${app.url}/api/version`, { headers: AUTH })
    assert.equal(res.status, 200)
    const { version } = await res.json()
    // Matches whatever package.json currently holds, so the bootstrap bump
    // does not break this test.
    assert.match(version, /^\d+\.\d+\.\d+$/)
  } finally {
    await app.close()
  }
})
