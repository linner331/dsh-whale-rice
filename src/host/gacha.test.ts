// node --experimental-strip-types --test src/host/gacha.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ItemTable, Rarity } from '../shared/items.ts'
import { pull, type Pity } from './gacha.ts'

const table = JSON.parse(readFileSync(new URL('../../assets/items/items.json', import.meta.url), 'utf8')) as ItemTable

/** Small deterministic PRNG (mulberry32) so the shares are reproducible. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('every rarity has items and every item a known rarity', () => {
  for (const r of Object.keys(table.rarities) as Rarity[]) assert.ok(table.items.some(i => i.rarity === r), r)
  for (const i of table.items) assert.ok(i.rarity in table.rarities, i.id)
  assert.equal(new Set(table.items.map(i => i.id)).size, table.items.length, 'ids are unique')
})

test('pity is never exceeded', () => {
  const random = seeded(1)
  let pity: Pity = { epic: 0, legendary: 0 }
  let sinceEpic = 0, sinceLegendary = 0
  for (let n = 0; n < 100_000; n++) {
    const p = pull(table, pity, random)
    pity = p.pity
    const r = p.item.rarity
    sinceEpic = r === 'epic' || r === 'legendary' ? 0 : sinceEpic + 1
    sinceLegendary = r === 'legendary' ? 0 : sinceLegendary + 1
    assert.ok(sinceEpic < table.pity.epic && sinceLegendary < table.pity.legendary)
    assert.deepEqual(pity, { epic: sinceEpic, legendary: sinceLegendary })
  }
})

test('shares follow the weights, nudged up only for epic and legendary by pity', () => {
  const random = seeded(2)
  const counts: Record<string, number> = {}
  let pity: Pity = { epic: 0, legendary: 0 }
  const N = 200_000
  for (let n = 0; n < N; n++) {
    const p = pull(table, pity, random)
    pity = p.pity
    counts[p.item.rarity] = (counts[p.item.rarity] ?? 0) + 1
  }
  const share = (r: Rarity): number => (counts[r] ?? 0) / N
  // Pity takes a little from the bottom three and gives it to the top two.
  for (const r of ['junk', 'common', 'rare'] as const) {
    assert.ok(share(r) <= table.rarities[r].weight / 100 + 0.005 && share(r) > table.rarities[r].weight / 100 - 0.04, `${r} ${share(r)}`)
  }
  assert.ok(share('epic') >= 0.08 && share('epic') < 0.14, `epic ${share('epic')}`)
  assert.ok(share('legendary') >= 0.02 && share('legendary') < 0.04, `legendary ${share('legendary')}`)
})

test('force picks a rarity or an item and still moves the counters', () => {
  const p = pull(table, { epic: 3, legendary: 7 }, Math.random, 'legendary')
  assert.equal(p.item.rarity, 'legendary')
  assert.deepEqual(p.pity, { epic: 0, legendary: 0 })
  const q = pull(table, { epic: 3, legendary: 7 }, Math.random, 'crab')
  assert.equal(q.item.id, 'crab')
  assert.deepEqual(q.pity, { epic: 4, legendary: 8 })
})
