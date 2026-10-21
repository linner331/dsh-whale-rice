/**
 * One pull: pick a rarity by weight, then an item of that rarity uniformly. Pity guarantees an
 * epic-or-better on the `pity.epic`-th pull without one, and a legendary on the `pity.legendary`-th.
 * Pure: the table, the counters and the random source come in, the result and new counters go out.
 */
import type { Item, ItemTable, Rarity } from '../shared/items.ts'

export interface Pity { epic: number; legendary: number }
export interface Pull { item: Item; pity: Pity }

const ORDER: Rarity[] = ['junk', 'common', 'rare', 'epic', 'legendary']

/** `force`: a rarity or an item id (director mode); it still moves the pity counters. */
export function pull(table: ItemTable, pity: Pity, random: () => number = Math.random, force?: string): Pull {
  const forced = force ? table.items.find(i => i.id === force) : undefined
  const rarity: Rarity = forced?.rarity
    ?? (ORDER.includes(force as Rarity) ? force as Rarity : undefined)
    ?? (pity.legendary + 1 >= table.pity.legendary ? 'legendary'
      : pity.epic + 1 >= table.pity.epic ? weighted(table, ['epic', 'legendary'], random)
      : weighted(table, ORDER, random))
  const pool = table.items.filter(i => i.rarity === rarity)
  const item = forced ?? pool[Math.floor(random() * pool.length)]
  return {
    item,
    pity: {
      epic: rarity === 'epic' || rarity === 'legendary' ? 0 : pity.epic + 1,
      legendary: rarity === 'legendary' ? 0 : pity.legendary + 1,
    },
  }
}

function weighted(table: ItemTable, among: Rarity[], random: () => number): Rarity {
  const total = among.reduce((sum, r) => sum + table.rarities[r].weight, 0)
  let x = random() * total
  for (const r of among) {
    x -= table.rarities[r].weight
    if (x < 0) return r
  }
  return among[among.length - 1]
}
