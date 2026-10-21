/** The treasure table (assets/items/items.json), shared by the host (drawing) and the pages (showing). */
import table from '../../assets/items/items.json'

export type Rarity = 'junk' | 'common' | 'rare' | 'epic' | 'legendary'
export interface Item { id: string; name: string; rarity: Rarity; icon: string; desc: string; line: string }
export interface ItemTable {
  rarities: Record<Rarity, { name: string; weight: number; color: string }>
  pity: { epic: number; legendary: number }
  items: Item[]
}

export const ITEMS = table as ItemTable
/** Best first: the order the bag and the collection are sorted in. */
export const RARITY_ORDER: Rarity[] = ['legendary', 'epic', 'rare', 'common', 'junk']
export const MAX_BAIT = 5

const byId = new Map(ITEMS.items.map(i => [i.id, i]))
export const itemById = (id: string): Item | undefined => byId.get(id)

/** What the bag looks like from the outside (pushed in every state snapshot). */
export interface BagView {
  bait: number
  /** Pulls since the last epic-or-better / legendary. */
  pity: { epic: number; legendary: number }
  items: Record<string, { count: number; firstAt: string; lastAt: string }>
}

export interface Catch { id: string; rarity: Rarity; isNew: boolean }
