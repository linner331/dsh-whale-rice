/**
 * Desktop overlay (macOS, Windows): runs the native whale-overlay helper so the whale can live
 * anywhere on screen, outside the DSH window. The helper's pages talk to a private 127.0.0.1 server
 * guarded by a random token, so they need no DSH browser session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hub } from './hub.ts'

/** Region in top-left-origin global screen points (spans the union of all displays). */
export interface ScreenRect { x: number; y: number; w: number; h: number }

const LIB_DIR = new URL('./', import.meta.url)          // lib/ at runtime
const ASSET_DIR = new URL('../assets/sprites/', import.meta.url)
const HELPER_NAME = process.platform === 'win32' ? 'whale-overlay.exe' : 'whale-overlay'
const HELPER = new URL(HELPER_NAME, LIB_DIR)
const STORE = join(homedir(), '.dsh', 'whale-rice', 'overlay.json')
const LOG = join(homedir(), '.dsh', 'whale-rice', 'overlay.log')
const MAX_RESTARTS = 3

const FILES: Record<string, [URL, string]> = {
  '/': [new URL('overlay.html', LIB_DIR), 'text/html; charset=utf-8'],
  '/overlay.js': [new URL('overlay.js', LIB_DIR), 'text/javascript; charset=utf-8'],
  '/assets/whale.webp': [new URL('whale.webp', ASSET_DIR), 'image/webp'],
}

export class OverlayHost {
  region: ScreenRect | null = null
  editing = false
  running = false

  private server: Server | undefined
  private child: ChildProcess | undefined
  private restarts = 0
  private stopped = false
  private readonly token = randomBytes(24).toString('hex')

  constructor(private readonly hub: Hub) {}

  static supported(): boolean {
    return (process.platform === 'darwin' || process.platform === 'win32') && existsSync(HELPER)
  }

  async start(): Promise<void> {
    await mkdir(dirname(STORE), { recursive: true })
    this.region = await loadRegion()
    const server = createServer((req, res) => void this.handle(req, res).catch(() => res.writeHead(500).end()))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.launch()
  }

  stop(): void {
    this.stopped = true
    this.child?.kill('SIGTERM')
    this.server?.close()
    this.server?.closeAllConnections()
    this.setRunning(false)
  }

  private launch(): void {
    if (this.stopped || !this.server) return
    const { port } = this.server.address() as { port: number }
    const url = `http://127.0.0.1:${port}/?t=${this.token}`
    let log: number | 'ignore' = 'ignore'
    try { log = openSync(LOG, 'w') } catch { /* keep going without a log */ }
    const child = spawn(fileURLToPath(HELPER), ['--url', url, '--ppid', String(process.pid)], {
      stdio: ['ignore', log, log],
      windowsHide: true,
    })
    this.child = child
    child.once('spawn', () => this.setRunning(true))
    child.once('error', () => this.crashed())
    child.once('exit', () => this.crashed())
  }

  private crashed(): void {
    this.child = undefined
    if (this.stopped) return
    this.setRunning(false)   // the in-app whale takes over while the helper is down
    if (++this.restarts > MAX_RESTARTS) return
    setTimeout(() => this.launch(), 2000 * this.restarts)
  }

  private setRunning(on: boolean): void {
    if (this.running === on) return
    this.running = on
    this.hub.emit()
  }

  /** DNS-rebinding guard: only requests addressed to our own 127.0.0.1 port. */
  private sameHost(req: IncomingMessage): boolean {
    const port = (this.server?.address() as { port: number } | null)?.port
    return req.headers.host === `127.0.0.1:${port}`
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    // Per-launch token (in the query for page/SSE loads, header for writes).
    if (!this.sameHost(req)) return false
    const given = Buffer.from(url.searchParams.get('t') ?? String(req.headers['x-whale-token'] ?? ''))
    const want = Buffer.from(this.token)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // The page script is public code and is requested by <script src> without the token.
    const isPublic = req.method === 'GET' && url.pathname === '/overlay.js' && this.sameHost(req)
    if (!isPublic && !this.authorized(req, url)) return void res.writeHead(403).end()

    if (req.method === 'GET') {
      if (url.pathname === '/events') return this.hub.open(req, res)
      const file = FILES[url.pathname]
      if (!file) return void res.writeHead(404).end()
      const bytes = await readFile(file[0])
      if (process.env.WHALE_DEBUG) console.error(`[whale-overlay] GET ${url.pathname} ${bytes.length}B`)
      return void res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }).end(bytes)
    }

    if (req.method === 'POST' && url.pathname === '/edit') {
      const body = await readJson(req) as { on?: unknown }
      this.editing = body.on === true
      this.hub.emit()
      return void res.writeHead(204).end()
    }
    if (req.method === 'POST' && url.pathname === '/region') {
      const r = await readJson(req) as Partial<ScreenRect>
      if (![r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v)) || r.w! < 80 || r.h! < 80) {
        return void res.writeHead(400).end()
      }
      this.region = { x: Math.round(r.x!), y: Math.round(r.y!), w: Math.round(r.w!), h: Math.round(r.h!) }
      this.editing = false
      await saveRegion(this.region)
      this.hub.emit()
      return void res.writeHead(204).end()
    }
    res.writeHead(405).end()
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 4096) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

async function loadRegion(): Promise<ScreenRect | null> {
  try {
    const data = JSON.parse(await readFile(STORE, 'utf8')) as { region?: ScreenRect }
    return data.region ?? null
  } catch { return null }
}

async function saveRegion(region: ScreenRect): Promise<void> {
  await mkdir(dirname(STORE), { recursive: true })
  await writeFile(STORE, JSON.stringify({ region }, null, 2))
}
