/**
 * The treasure bag, kept by the host in ~/.dsh/whale-rice/bag.json: bait earned by the agent's
 * turns, the pity counters, and everything she has fished up. Pulls are drawn and saved here the
 * moment a dive starts; the pages only act it out, so closing DSH mid-dive loses nothing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ITEMS, MAX_BAIT, type BagView, type Catch } from '../shared/items.ts'
import { pull } from './gacha.ts'

// WHALE_RICE_BAG: another file (the dev harness keeps its catches away from the real bag)
const STORE = process.env.WHALE_RICE_BAG || join(homedir(), '.dsh', 'whale-rice', 'bag.json')
const LOG_SIZE = 50
const DIVE_LOCK_MS = 20_000   // one dive is acted out in well under this; a second one waits

interface BagFile extends BagView {
  version: 1
  log: Array<{ id: string; at: string }>
}

export type DiveRefusal = 'busy' | 'no-bait'

export class Bag {
  private data: BagFile = { version: 1, bait: 1, pity: { epic: 0, legendary: 0 }, items: {}, log: [] }
  private lockedUntil = 0
  private saving = Promise.resolve()
  onChange: (() => void) | undefined

  async load(): Promise<void> {
    try {
      const d = JSON.parse(await readFile(STORE, 'utf8')) as Partial<BagFile>
      if (d.version === 1) this.data = { ...this.data, ...d }
    } catch { /* first run: one bait to try it out */ }
  }

  view(): BagView {
    const { bait, pity, items } = this.data
    return { bait, pity, items }
  }

  /** A turn finished: one bait, two for a long one. */
  earn(n: number): void {
    if (this.data.bait >= MAX_BAIT) return   // never cut down bait set higher by hand
    const bait = Math.min(MAX_BAIT, this.data.bait + n)
    this.data.bait = bait
    this.changed()
  }

  /** `force` (director mode only): a rarity or item id, and no bait is spent. */
  dive(force?: string): Catch | DiveRefusal {
    const now = Date.now()
    if (!force && now < this.lockedUntil) return 'busy'
    if (!force && this.data.bait < 1) return 'no-bait'
    const { item, pity } = pull(ITEMS, this.data.pity, Math.random, force)
    const at = new Date(now).toISOString()
    const had = this.data.items[item.id]
    this.data.items[item.id] = { count: (had?.count ?? 0) + 1, firstAt: had?.firstAt ?? at, lastAt: at }
    this.data.pity = pity
    if (!force) this.data.bait--
    this.data.log = [{ id: item.id, at }, ...this.data.log].slice(0, LOG_SIZE)
    if (!force) this.lockedUntil = now + DIVE_LOCK_MS
    this.changed()
    return { id: item.id, rarity: item.rarity, isNew: !had }
  }

  private changed(): void {
    this.onChange?.()
    const text = JSON.stringify(this.data, null, 2)
    // Writes are queued and land via rename, so a crash never leaves half a file.
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(STORE), { recursive: true })
      await writeFile(`${STORE}.tmp`, text)
      await rename(`${STORE}.tmp`, STORE)
    }).catch(err => console.warn(`whale-rice: saving the bag failed: ${err}`))
  }
}
