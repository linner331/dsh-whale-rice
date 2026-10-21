/** The treasure artwork (assets/treasure, built by scripts/sprites/build_treasure.py) and where it is measured to be. */
import meta from '../../assets/treasure/treasure.json'

export const TREASURE = meta
/** The hole's opening inside the glass image (fractions): the beach is shown in exactly that box. */
export const HOLE = meta.hole
/** Depth lines of the beach image, as fractions from its top. */
export const BEACH = meta.beach

const FILES = { items: 'items', beach: 'beach', crack: 'glass-crack', rim: 'glass-rim', mask: 'hole-mask', shards: 'glass-shards' } as const

/** Hand the images to the stylesheet as `--wr-<name>` on the layer; `url` maps an asset path to a fetchable URL. */
export function paintTreasure(layer: HTMLElement, url: (path: string) => string): void {
  for (const [name, file] of Object.entries(FILES)) {
    layer.style.setProperty(`--wr-${name}`, `url("${url(`assets/treasure/${file}.webp?v=${meta.version}`)}")`)
  }
}
