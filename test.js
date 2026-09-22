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
import { classifyLine } from './static/lines.js'
import {
  parseSubject, parseCommits, bumpLevel, nextVersion, renderChangelog, readNotes,
} from './tools/release.js'

let sockSeq = 0

/**
 * Stands up a fake Herdr speaking NDJSON on a Unix socket.
 * `handler(req)` returns the object merged into `{id}` for the response,
 * e.g. `{result: {...}}` or `{error: {code, message}}`. Returning
 * `undefined` sends nothing, which exercises the timeout path.
 * Returns `{path, calls, close}` — `calls` accumulates every parsed request.
 */
async function fakeHerdr(handler) {
  const path = join(tmpdir(), `herdr-test-${process.pid}-${sockSeq++}.sock`)
  const calls = []
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        calls.push(req)
        const res = handler(req)
        if (res !== undefined) sock.write(JSON.stringify({ id: req.id, ...res }) + '\n')
      }
    })
  })
  await new Promise((resolve) => server.listen(path, resolve))
  return {
    path,
    calls,
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

test('a feed poll that lands after Back does not read status off null', () => {
  const script = join(tmpdir(), `herdr-feed-race-${process.pid}.mjs`)
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
    let releaseFeed
    globalThis.fetch = (path) => {
      const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body })
      if (String(path).includes('/feed')) {
        return new Promise((resolve) => {
          releaseFeed = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ status: 'working', text: 'hello\\n', hash: 'abc', source: 'recent' }),
          })
        })
      }
      if (String(path).includes('/api/version')) return ok({ version: '0.0.0' })
      if (String(path).includes('/api/theme')) return ok({ colors: {} })
      return ok({ agents: [] })
    }
    const { showFeed, showList } = await import(${JSON.stringify(new URL('./static/app.js', import.meta.url).href)})
    showFeed({ pane_id: 'w1:p1', title: 'grok', status: 'idle', agent: 'grok', dir: 'proj' })
    if (!releaseFeed) throw new Error('feed poll never started')
    showList()
    releaseFeed()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const message = node('error-bar').textContent
    if (/status/i.test(message)) {
      console.error(message)
      process.exit(1)
    }
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
    close: () => new Promise((resolve) => server.close(resolve)),
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

test('GET feed returns cleaned text, a hash, and the current status', async () => {
  const fake = await fakeHerdr((req) =>
    req.method === 'agent.list'
      ? AGENT_LIST
      : { result: { type: 'pane_read', read: { text: 'hello\n────────────────────────────\nworld', truncated: false } } }
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents/w2:p3/feed`, { headers: AUTH })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, 'hello\nworld')
    assert.equal(body.status, 'blocked')
    assert.equal(body.truncated, false)
    assert.equal(body.hash, hashFeed('hello\nworld'))

    const read = fake.calls.find((c) => c.method === 'agent.read')
    assert.equal(read.params.target, 'w2:p3')
    assert.equal(read.params.source, 'recent')
    assert.equal(read.params.strip_ansi, true)
    assert.equal(read.params.lines, 1000)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET feed with a matching hash returns unchanged and no body text', async () => {
  const text = 'stable output'
  const fake = await fakeHerdr((req) =>
    req.method === 'agent.list'
      ? AGENT_LIST
      : { result: { type: 'pane_read', read: { text, truncated: false } } }
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const h = hashFeed(text)
    const same = await (await fetch(`${app.url}/api/agents/w2:p3/feed?h=${h}`, { headers: AUTH })).json()
    assert.deepEqual(same, { unchanged: true, hash: h, status: 'blocked', source: 'recent' })

    const differs = await (await fetch(`${app.url}/api/agents/w2:p3/feed?h=nope`, { headers: AUTH })).json()
    assert.equal(differs.text, text)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET feed clamps lines and defaults recent to 1000', async () => {
  const fake = await fakeHerdr((req) =>
    req.method === 'agent.list'
      ? AGENT_LIST
      : { result: { type: 'pane_read', read: { text: 'x', truncated: true } } }
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    await fetch(`${app.url}/api/agents/w2:p3/feed?source=recent`, { headers: AUTH })
    await fetch(`${app.url}/api/agents/w2:p3/feed?source=recent&lines=9000`, { headers: AUTH })
    await fetch(`${app.url}/api/agents/w2:p3/feed?source=bogus`, { headers: AUTH })
    const reads = fake.calls.filter((c) => c.method === 'agent.read')
    assert.equal(reads[0].params.lines, 1000)
    assert.equal(reads[1].params.lines, 1000)
    assert.equal(reads[2].params.source, 'recent', 'an unknown source falls back rather than passing through')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET feed defaults to the scrollback, not the visible screen', async () => {
  const fake = await fakeHerdr(
    herdrFixture(() => ({ result: { type: 'pane_read', read: { text: 'x', truncated: false } } }))
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const body = await (await fetch(`${app.url}/api/agents/w2:p3/feed`, { headers: AUTH })).json()
    const read = fake.calls.find((c) => c.method === 'agent.read')
    assert.equal(read.params.source, 'recent')
    assert.equal(read.params.lines, 1000)
    assert.equal(body.source, 'recent', 'the body reports which source actually answered')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET feed falls back to the visible screen when the agent is mid-work', async () => {
  // Herdr refuses scrollback for a working alternate-screen TUI; the phone must
  // still get the screen rather than a 502.
  const fake = await fakeHerdr(
    herdrFixture((req) =>
      req.params.source === 'recent'
        ? { error: { code: 'agent_not_idle', message: 'cannot read 1000 lines while w2:p3 is working' } }
        : { result: { type: 'pane_read', read: { text: 'the screen', truncated: false } } }
    )
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents/w2:p3/feed`, { headers: AUTH })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, 'the screen')
    assert.equal(body.source, 'visible', 'the client is told it is looking at the screen')
    const reads = fake.calls.filter((c) => c.method === 'agent.read')
    assert.deepEqual(reads.map((r) => r.params.source), ['recent', 'visible'])
  } finally {
    await app.close()
    await fake.close()
  }
})

test('an explicit source=visible is honoured and not upgraded', async () => {
  const fake = await fakeHerdr(
    herdrFixture(() => ({ result: { type: 'pane_read', read: { text: 'x', truncated: false } } }))
  )
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const body = await (
      await fetch(`${app.url}/api/agents/w2:p3/feed?source=visible`, { headers: AUTH })
    ).json()
    const read = fake.calls.find((c) => c.method === 'agent.read')
    assert.equal(read.params.source, 'visible')
    assert.equal(read.params.lines, 60)
    assert.equal(body.source, 'visible')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('GET feed for an agent that has ended returns 404 without reading', async () => {
  const fake = await fakeHerdr(() => AGENT_LIST)
  process.env.HERDR_SOCKET_PATH = fake.path
  process.env.ALLOWED_LOGIN = 'user@example.com'
  const app = await startServer()
  try {
    const res = await fetch(`${app.url}/api/agents/w9:p9/feed`, { headers: AUTH })
    assert.equal(res.status, 404)
    assert.equal(fake.calls.filter((c) => c.method === 'agent.read').length, 0)
  } finally {
    await app.close()
    await fake.close()
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
