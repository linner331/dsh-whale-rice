/**
 * Web half of dsh-whale-rice. Mounts a fixed overlay with the whale maid inside the DSH window and
 * follows the node half's event stream. When the desktop overlay (macOS) is running she lives there
 * instead, and this one steps aside. Everything is removed when the plugin unloads.
 */
import css from '../shared/style.css'
import { feed, type WhaleState } from '../shared/feed.ts'
import { LocalRegion } from '../shared/region.ts'
import { ATLAS } from '../shared/sprite.ts'
import { paintTreasure } from '../shared/treasure-art.ts'
import { Whale, type Diver } from '../shared/whale.ts'

interface ClientContext {
  effect(fn: () => () => void, label?: string): void
}

const PLUGIN_ID = 'dsh-whale-rice'

const hostUrl = (path: string): string => new URL(`whale-rice/${path}`, document.baseURI).href

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PLUGIN_ID
    style.textContent = css
    document.head.append(style)

    const layer = document.createElement('div')
    layer.className = 'wr-layer'
    document.body.append(layer)
    paintTreasure(layer, hostUrl)
    const whale = new Whale(layer, hostUrl(`assets/${ATLAS}`), new LocalRegion(layer), undefined, dive)
    const stopFollowing = followState(whale, layer)
    // Dev harness hook: ?whale-debug exposes the instance (e.g. window.__whale.roll('left')).
    if (new URLSearchParams(location.search).has('whale-debug')) Object.assign(window, { __whale: whale })

    return () => {
      stopFollowing()
      whale.dispose()
      layer.remove()
      style.remove()
    }
  }, `${PLUGIN_ID}: whale overlay`)
}

const dive: Diver = async (force) => {
  const res = await fetch(hostUrl('dive'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(force ? { force } : {}),
  })
  return res.json()
}

function followState(whale: Whale, layer: HTMLElement): () => void {
  let last: WhaleState | null = null
  const source = new EventSource(hostUrl('events'), { withCredentials: true })

  source.onmessage = (message) => {
    const s = JSON.parse(message.data) as WhaleState
    layer.hidden = s.overlay
    if (s.overlay) whale.setActivity('idle')   // the desktop whale reacts instead
    else feed(whale, s, last)
    last = s
  }
  // A dropped stream (host restart) reconnects by itself; stop eating until it is back.
  source.onerror = () => { last = null; whale.setActivity('idle') }

  return () => source.close()
}
