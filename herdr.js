import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

/**
 * The complete set of Herdr methods this adapter may ever emit.
 *
 * This is a capability boundary, not a filter. Herdr's socket API also exposes
 * pane.split, layout.apply, and plugin.action.invoke, all of which take argv
 * and spawn processes — proxying them would turn this into a remote code
 * execution endpoint reachable by anything on the tailnet.
 */
export const ALLOWED_METHODS = new Set([
  'agent.list',
  'workspace.list',
  'agent.read',
  'agent.prompt',
  'pane.send_input',
  'agent.focus',
  // Read-only: the socket pushes pane and status events, it cannot act.
  'events.subscribe',
])

export class HerdrError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'HerdrError'
    this.code = code
  }
}

/**
 * Sends one request to Herdr and resolves with its `result` object.
 *
 * One connection per call. Reads come at most every 500ms, so a pool would buy
 * nothing and cost us a half-open-socket failure mode across Herdr restarts —
 * which happen on every `omarchy update`.
 */
export function herdr(method, params = {}, { timeout = 5000 } = {}) {
  if (!ALLOWED_METHODS.has(method)) {
    return Promise.reject(new HerdrError('method_not_allowed', `method not allowed: ${method}`))
  }

  const socketPath = process.env.HERDR_SOCKET_PATH
  const id = randomUUID()

  return new Promise((resolve, reject) => {
    const sock = connect(socketPath)
    let buf = ''
    let settled = false

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      fn(arg)
    }

    const timer = setTimeout(
      () => finish(reject, new HerdrError('timeout', `herdr did not answer ${method} in ${timeout}ms`)),
      timeout
    )

    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'))

    sock.on('data', (chunk) => {
      buf += chunk
      const i = buf.indexOf('\n')
      if (i === -1) return
      let msg
      try {
        msg = JSON.parse(buf.slice(0, i))
      } catch {
        return finish(reject, new HerdrError('bad_response', 'herdr sent malformed JSON'))
      }
      if (msg.error) return finish(reject, new HerdrError(msg.error.code, msg.error.message))
      finish(resolve, msg.result)
    })

    sock.on('error', (err) =>
      finish(reject, new HerdrError('socket_unavailable', `cannot reach herdr: ${err.message}`))
    )

    sock.on('close', () =>
      finish(reject, new HerdrError('socket_unavailable', 'herdr closed the connection'))
    )
  })
}

/**
 * Opens an `events.subscribe` connection and calls `onEvent(name, data)` for
 * each event Herdr pushes.
 *
 * `started` resolves once Herdr confirms the subscription and rejects if the
 * connection fails first. `closed` resolves when the connection ends for any
 * reason, including `close()`. The caller owns reconnecting: a Herdr restart
 * simply ends the connection.
 */
export function subscribe(subscriptions, onEvent) {
  const sock = connect(process.env.HERDR_SOCKET_PATH)
  let buf = ''
  let start
  const started = new Promise((resolve, reject) => (start = { resolve, reject }))
  // A caller that never reached `await started` must not see an unhandled rejection.
  started.catch(() => {})
  const closed = new Promise((resolve) =>
    sock.on('close', () => {
      start.reject(new HerdrError('socket_unavailable', 'herdr closed the subscription'))
      resolve()
    })
  )

  sock.on('error', () => {}) // surfaces as 'close', which is all a caller acts on
  sock.on('connect', () =>
    sock.write(JSON.stringify({ id: randomUUID(), method: 'events.subscribe', params: { subscriptions } }) + '\n')
  )
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.error) {
        start.reject(new HerdrError(msg.error.code, msg.error.message))
        sock.destroy()
        return
      }
      if (msg.result?.type === 'subscription_started') start.resolve()
      else if (msg.event) onEvent(msg.event, msg.data)
    }
  })

  return { started, closed, close: () => sock.destroy() }
}
