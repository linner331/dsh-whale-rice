/**
 * Node half of dsh-whale-rice.
 * - watches session events to know what the agent is doing (eating, taking notes, asking, …)
 * - polls the DeepSeek balance (only with an API key) for the hover tooltip; nothing is guessed
 * - on macOS, runs a desktop overlay so she can roam anywhere on screen (see overlay-host.ts)
 * - keeps her treasure bag: bait earned per turn, dives drawn and saved here (bag.ts)
 * - serves <base>/whale-rice/state (JSON), /events (SSE), POST /dive and the sprite sheet under /assets/
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BalanceTracker } from './balance.ts'
import { ActivityTracker, CHEER_AFTER_MS } from './activity.ts'
import { Bag } from './bag.ts'
import { Hub } from './hub.ts'
import { OverlayHost, readJson } from './overlay-host.ts'
import { Director } from './director.ts'

export const name = 'whale-rice'

export interface Config {
  /** Credential reference (env-var style name) holding the DeepSeek API key. */
  apiKeyRef?: string
  /** Background poll interval in seconds. */
  pollSeconds?: number
  baseUrl?: string
  /** macOS: show her on the desktop (anywhere on screen) instead of inside the DSH window. */
  desktop?: boolean
  /** Director mode for demos/debugging: loopback endpoint that triggers behaviours (see director.ts). Off by default. */
  director?: boolean | { port?: number }
}

// Minimal structural types for the host services we touch; the real ones come from the DSH host.
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
interface HostContext {
  inject(deps: string[], fn: (ctx: HostContext) => void): void
  get(name: string): any
  on(event: string, listener: (...args: any[]) => void): () => void
  effect(fn: () => () => void, label?: string): void
}

const ROUTE = '/whale-rice'
const SPRITES = new URL('../assets/sprites/', import.meta.url)
const TREASURE = new URL('../assets/treasure/', import.meta.url)
const ASSETS = new Map<string, [URL, string]>([
  ['whale.webp', [SPRITES, 'image/webp']],
  ['whale.json', [SPRITES, 'application/json']],
  ...['items', 'beach', 'glass-crack', 'glass-rim', 'hole-mask', 'glass-shards']
    .map(name => [`treasure/${name}.webp`, [TREASURE, 'image/webp']] as [string, [URL, string]]),
])
// Billing lands a little after the reply finishes, so refresh the balance twice.
const AFTER_TURN_DELAYS_MS = [3_000, 15_000]

export function apply(ctx: HostContext, config: Config = {}): void {
  const keyRef = config.apiKeyRef ?? 'DEEPSEEK_API_KEY'
  const pollMs = Math.max(15, config.pollSeconds ?? 60) * 1000

  // The key is re-resolved on every poll (the credentials service forbids caching) and never leaves the host.
  let credentials: { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
  ctx.inject(['credentials'], (c) => {
    credentials = c.get('credentials')
    c.effect(() => () => { credentials = undefined }, 'whale-rice: credentials')
  })
  const tracker = new BalanceTracker(async () => {
    const resolved = await credentials?.resolve(keyRef).catch(() => undefined)
    return resolved?.value || process.env[keyRef]
  }, (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, ''))

  const activity = new ActivityTracker()
  const bag = new Bag()
  let overlay: OverlayHost | undefined
  let director: Director | undefined
  const snapshot = () => ({
    ...tracker.state,
    activity: activity.activity,
    outcome: activity.outcome,
    overlay: overlay?.running ?? false,
    region: overlay?.region ?? null,
    editing: overlay?.editing ?? false,
    director: director?.cue ?? null,
    bag: bag.view(),
  })
  const hub = new Hub(snapshot)
  ctx.effect(() => {
    const unsubscribe = activity.subscribe(hub.emit)
    tracker.onChange = hub.emit
    bag.onChange = hub.emit
    activity.onTurnEnd = ms => bag.earn(ms >= CHEER_AFTER_MS ? 2 : 1)
    void bag.load().then(hub.emit)
    return () => {
      unsubscribe()
      tracker.onChange = undefined
      bag.onChange = undefined
      activity.onTurnEnd = undefined
      activity.dispose()
      hub.dispose()
    }
  }, 'whale-rice: state hub')

  if (config.director) {
    const port = (typeof config.director === 'object' && config.director.port) || 8771
    ctx.effect(() => {
      const d = new Director(port, hub.emit)
      director = d
      d.start()
      return () => { d.stop(); director = undefined }
    }, 'whale-rice: director')
  }

  ctx.effect(() => {
    void tracker.poll()
    const timer = setInterval(() => void tracker.poll(), pollMs)
    return () => clearInterval(timer)
  }, 'whale-rice: balance poll')

  // A page asks to dive: draw now (the result is saved before any animation), or say why not.
  // `force` (a rarity or item id, no bait spent) is only honoured in director mode.
  const dive = (body: unknown): [status: number, body: unknown] => {
    const asked = (body as { force?: unknown } | null)?.force
    const force = config.director && typeof asked === 'string' ? asked : undefined
    if (activity.activity !== 'idle' && !force) return [409, { refused: 'working' }]
    const result = bag.dive(force)
    return typeof result === 'string' ? [409, { refused: result }] : [200, result]
  }

  if (config.desktop !== false && OverlayHost.supported()) {
    ctx.effect(() => {
      const host = new OverlayHost(hub, dive)
      overlay = host
      void host.start()
      return () => { host.stop(); overlay = undefined }
    }, 'whale-rice: desktop overlay')
  }

  const pending = new Set<ReturnType<typeof setTimeout>>()
  ctx.effect(() => () => pending.forEach(clearTimeout), 'whale-rice: after-turn timers')
  ctx.on('session/event', (session: { id?: string }, event: { type?: string; data?: unknown }) => {
    if (event) activity.onSessionEvent(String(session?.id ?? 'default'), event)
    if (event?.type !== 'turn/end') return
    for (const delay of AFTER_TURN_DELAYS_MS) {
      const t = setTimeout(() => { pending.delete(t); void tracker.poll() }, delay)
      pending.add(t)
    }
  })

  // Only mount the route where the web composition's connection fence exists.
  ctx.inject(['webServer', 'connection'], (web) => {
    const server = web.get('webServer')
    const connection = web.get('connection') as { requestRejection(req: IncomingMessage): 401 | 403 | undefined }
    web.effect(() => server.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        // Host/Origin fence + browser-session auth, same as the shipped host routes.
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) return void res.writeHead(rejection).end()
        const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(ROUTE.length)
        if (req.method === 'POST' && path === '/dive') {
          const [status, body] = dive(await readJson(req).catch(() => ({})))
          return sendJson(res, body, status)
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end()
        if (path === '/state') return sendJson(res, snapshot())
        if (path === '/events') return hub.open(req, res)
        if (path.startsWith('/assets/')) return sendAsset(req, res, path.slice('/assets/'.length))
        res.writeHead(404).end()
      },
    } satisfies WebRoute), 'whale-rice: http route')
  })
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(text)
}

async function sendAsset(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const asset = ASSETS.get(file)
  if (!asset) return void res.writeHead(404).end()
  const [dir, type] = asset
  const bytes = await readFile(new URL(file.replace(/^treasure\//, ''), dir))
  // Only content-hashed URLs (…?v=<hash>) may be cached forever; anything else is revalidated.
  const versioned = new URL(req.url ?? '/', 'http://localhost').searchParams.has('v')
  const cache = versioned ? 'public, max-age=31536000, immutable' : 'no-cache'
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': bytes.length }).end(bytes)
}
