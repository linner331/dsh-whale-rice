// Local harness: runs the real node half (lib/index.js) against a fake Cordis context and a mock
// DeepSeek balance API, and serves a page that loads lib/client.js through a fake module loader.
//   node dev/serve.mjs  → http://127.0.0.1:8770
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const PORT = Number(process.env.PORT ?? 8770)
const root = new URL('../', import.meta.url)

// ---- mock DeepSeek balance ---------------------------------------------------------------------
let balance = 12.3456
const mockRoutes = {
  '/mock-deepseek/user/balance': (req, res) => {
    if (req.headers.authorization !== 'Bearer dev-key') return res.writeHead(401).end()
    json(res, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: balance.toFixed(4) }] })
  },
  '/dev/spend': (_req, res) => { balance -= 0.0123 + Math.random() * 0.02; json(res, { balance }) },
  '/dev/topup': (_req, res) => { balance += 10; json(res, { balance }) },
  '/dev/turn-end': (_req, res) => { emit('session/event', { id: 'dev' }, { type: 'turn/end', data: { turn: 1 } }); json(res, { ok: true }) },
  // Any session event: /dev/event?type=approval/asked&data={"id":"a1"}
  '/dev/event': (req, res) => {
    const u = new URL(req.url, 'http://x')
    emit('session/event', { id: 'dev' }, { type: u.searchParams.get('type'), data: JSON.parse(u.searchParams.get('data') ?? '{}') })
    json(res, { ok: true })
  },
  // A model call: step/start … assistant/message (tokens flowing), then step/end.
  '/dev/gen-start': (_req, res) => { emit('session/event', { id: 'dev' }, { type: 'step/start', data: { turn: 1, step: 1 } }); json(res, { ok: true }) },
  '/dev/gen-stop': (_req, res) => {
    for (const type of ['assistant/message', 'step/end']) emit('session/event', { id: 'dev' }, { type, data: {} })
    json(res, { ok: true })
  },
}

// ---- fake cordis context -----------------------------------------------------------------------
const listeners = new Map()
const routes = []
const services = {
  webServer: { register: r => { routes.push(r); return () => routes.splice(routes.indexOf(r), 1) } },
  // Real fence checks Host/Origin + login cookie; the harness only refuses cross-origin calls.
  connection: { requestRejection: req => (req.headers.origin && !req.headers.origin.includes(`127.0.0.1:${PORT}`) ? 403 : undefined) },
  credentials: { resolve: async ref => (process.env[ref] ? { value: process.env[ref], source: 'env' } : undefined) },
}
const ctx = {
  inject: (_deps, fn) => fn(ctx),
  get: name => { if (!(name in services)) throw new Error(`no service ${name}`); return services[name] },
  on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => {} },
  effect: fn => fn(),
}
const emit = (event, ...args) => (listeners.get(event) ?? []).forEach(fn => fn(...args))

process.env.DEEPSEEK_API_KEY = 'dev-key'
const plugin = await import(new URL('lib/index.js', root))
// DESKTOP=1 also runs the macOS desktop overlay; by default the whale stays in this page.
// Director mode is on here: curl 'http://127.0.0.1:8771/?act=run&arg=left'
plugin.apply(ctx, { baseUrl: `http://127.0.0.1:${PORT}/mock-deepseek`, pollSeconds: 15, desktop: process.env.DESKTOP === '1', director: true })

// ---- http ---------------------------------------------------------------------------------------
const files = { '/': ['dev/index.html', 'text/html'], '/lib/client.js': ['lib/client.js', 'text/javascript'] }

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (mockRoutes[path]) return mockRoutes[path](req, res)
  const route = routes.find(r => r.kind === 'exact' ? r.path === path : path === r.path || path.startsWith(`${r.path}/`))
  if (route) return route.handler(req, res)
  const file = files[path]
  if (!file) return res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': file[1] }).end(await readFile(new URL(file[0], root)))
}).listen(PORT, '127.0.0.1', () => console.log(`whale-rice dev harness on http://127.0.0.1:${PORT}`))

function json(res, body) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)) }
