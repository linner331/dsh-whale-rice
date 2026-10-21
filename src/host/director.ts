/**
 * Director mode (opt-in, `director: true` in the plugin config): a loopback-only HTTP endpoint
 * that tells the whale to act out something right now — for recording demos and debugging the
 * behaviours that otherwise only happen by chance or after a long wait. The animations and the
 * state machine are the real ones; only the trigger is manual.
 *
 *   curl 'http://127.0.0.1:8771/?act=run&arg=left'
 *
 * Acts: run|walk (arg left/right), roll (arg left/right), sleep, oops, full, cheer,
 *       feel (arg: an emotion event, e.g. praise / faceplant), calm,
 *       grab (arg "seconds,vx,vy": hold, then throw with that velocity in px/s),
 *       region (arg "x,y,w,h": her in-app area as fractions of the window),
 *       dive (arg: a rarity or an item id; no bait is spent), admire (take a treasure out to look at).
 */
import { createServer, type Server } from 'node:http'

export const DIRECTOR_ACTS = ['run', 'walk', 'roll', 'sleep', 'oops', 'full', 'cheer', 'feel', 'calm', 'grab', 'region', 'dive', 'admire'] as const
export type DirectorAct = typeof DIRECTOR_ACTS[number]
export interface DirectorCue { seq: number; act: DirectorAct; arg: string | null }

export class Director {
  cue: DirectorCue | null = null
  private server: Server | undefined

  constructor(private readonly port: number, private readonly onCue: () => void) {}

  start(): void {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const act = url.searchParams.get('act') as DirectorAct | null
      if (!act || !DIRECTOR_ACTS.includes(act)) {
        return void res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`act must be one of: ${DIRECTOR_ACTS.join(', ')}\n`)
      }
      this.cue = { seq: (this.cue?.seq ?? 0) + 1, act, arg: url.searchParams.get('arg') }
      this.onCue()
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(`${JSON.stringify(this.cue)}\n`)
    })
    this.server.on('error', err => console.warn(`whale-rice director: ${err.message}`))
    this.server.listen(this.port, '127.0.0.1')
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
  }
}
