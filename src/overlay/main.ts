/**
 * Desktop overlay page. One copy runs per screen inside the native whale-overlay helper; the copy
 * whose screen holds the region's centre hosts the whale. Coordinates: the region is stored in
 * top-left-origin global screen points; this page covers the screen at (sx, sy, sw, sh).
 */
import css from '../shared/style.css'
import { feed, type ScreenRect, type WhaleState } from '../shared/feed.ts'
import type { RegionSource } from '../shared/region.ts'
import { ATLAS } from '../shared/sprite.ts'
import { Whale } from '../shared/whale.ts'

declare global {
  interface Window {
    webkit?: { messageHandlers?: { whale?: { postMessage(body: unknown): void } } }
    /** WebView2 host bridge (Windows helper). */
    chrome?: {
      webview?: {
        postMessage(body: unknown): void
        addEventListener?(type: 'message', handler: (event: { data: unknown }) => void): void
      }
    }
  }
}

/** Talk to whichever native helper hosts this page: WKWebView (macOS) or WebView2 (Windows). */
const send = (body: unknown): void => {
  window.webkit?.messageHandlers?.whale?.postMessage(body)
  window.chrome?.webview?.postMessage(body)
}

// The Windows helper reads Escape from a low-level hook (it never takes the foreground) and forwards
// it here, so the picker behaves the same as it does on macOS.
window.chrome?.webview?.addEventListener?.('message', (event) => {
  const data = event.data as { type?: unknown; key?: unknown } | null
  if (data?.type === 'key' && typeof data.key === 'string') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: data.key }))
  }
})

// Surface page errors in ~/.dsh/whale-rice/overlay.log via the native helper.
const nativeLog = (text: string): void => send({ type: 'log', text })
window.addEventListener('error', e => nativeLog(`${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', e => nativeLog(`unhandled: ${String(e.reason)}`))
nativeLog(`page up: ${location.pathname}${location.search.replace(/[?&]t=[^&]*/, '')}`)

const params = new URLSearchParams(location.search)
const token = params.get('t') ?? ''
const screen = { x: num('sx'), y: num('sy'), w: num('sw') || innerWidth, h: num('sh') || innerHeight }
const isMainScreen = screen.x === 0 && screen.y === 0
const DEFAULT_SIZE = { w: 640, h: 320 }   // wide enough for a somersault (~350px)

function num(name: string): number { return Number(params.get(name) ?? 0) }
const api = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const style = document.createElement('style')
style.textContent = `${css}\nhtml, body { margin: 0; background: transparent; overflow: hidden; }`
document.head.append(style)
const layer = document.createElement('div')
layer.className = 'wr-layer'
document.body.append(layer)

let state: WhaleState | null = null
let whale: Whale | null = null

/** The stored region, or a default corner of the main screen before the user picks one. */
function globalRegion(): ScreenRect | null {
  if (state?.region) return state.region
  if (!isMainScreen) return null
  return { x: screen.w - DEFAULT_SIZE.w - 24, y: screen.h - DEFAULT_SIZE.h - 24, ...DEFAULT_SIZE }
}

function hostsWhale(): boolean {
  const r = globalRegion()
  if (!r) return false
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  return cx >= screen.x && cx < screen.x + screen.w && cy >= screen.y && cy < screen.y + screen.h
}

const regions: RegionSource = {
  rect() {
    const r = globalRegion() ?? { x: 0, y: 0, ...DEFAULT_SIZE }
    return new DOMRect(r.x - screen.x, r.y - screen.y, r.w, r.h)
  },
  // Region picking spans every screen, so it is driven by the host: ask, and keep roaming meanwhile.
  async edit() { await post('/edit', { on: true }) },
}

// ---- state stream ------------------------------------------------------------------------------

const source = new EventSource(api('/events'))
source.onmessage = (message) => {
  const s = JSON.parse(message.data) as WhaleState
  const prev = state
  state = s
  syncWhale(prev)
  if (whale) feed(whale, s, prev)
  syncPicker(s.editing)
}
source.onerror = () => { nativeLog('state stream lost'); whale?.setActivity('idle') }

function syncWhale(prev: WhaleState | null): void {
  if (hostsWhale() && !whale) {
    whale = new Whale(layer, api(`/assets/${ATLAS}`), regions)
  } else if (!hostsWhale() && whale) {
    whale.dispose()
    whale = null
  } else if (whale && JSON.stringify(prev?.region) !== JSON.stringify(state?.region)) {
    whale.regionChanged()
  }
}

// ---- region picker: drag a rectangle on any screen ---------------------------------------------

let picker: HTMLElement | null = null

function syncPicker(editing: boolean): void {
  if (editing && !picker) picker = openPicker()
  else if (!editing && picker) { picker.remove(); picker = null }
}

function openPicker(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'wr-picker'
  el.innerHTML = '<div class="wr-picker-hint">在任意屏幕上拖拽，框出鲸鱼娘的活动范围<br><small>Esc 或右键取消</small></div>'
    + '<div class="wr-picker-box" hidden></div>'
  const box = el.querySelector<HTMLElement>('.wr-picker-box')!
  let start: { x: number; y: number } | null = null
  const rect = (e: PointerEvent) => {
    const x = Math.min(start!.x, e.clientX), y = Math.min(start!.y, e.clientY)
    return { x, y, w: Math.abs(e.clientX - start!.x), h: Math.abs(e.clientY - start!.y) }
  }
  const cancel = () => void post('/edit', { on: false })

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    start = { x: e.clientX, y: e.clientY }
    el.setPointerCapture(e.pointerId)
    box.hidden = false
  })
  el.addEventListener('pointermove', e => {
    if (!start) return
    const r = rect(e)
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
  })
  el.addEventListener('pointerup', e => {
    if (!start) return
    const r = rect(e)
    start = null
    box.hidden = true
    if (r.w < 80 || r.h < 80) return   // too small: treat as a stray click, keep picking
    void post('/region', { x: r.x + screen.x, y: r.y + screen.y, w: r.w, h: r.h })
  })
  el.addEventListener('contextmenu', e => { e.preventDefault(); cancel() })
  window.addEventListener('keydown', function onKey(e) {
    if (!el.isConnected) return window.removeEventListener('keydown', onKey)
    if (e.key === 'Escape') cancel()
  })
  layer.append(el)
  return el
}

// ---- click-through: tell the native window what is clickable -----------------------------------

let lastHit = ''
setInterval(() => {
  const rects = whale ? [whale.hitRect()].map(r => [r.x, r.y, r.width, r.height].map(Math.round)) : []
  // `capture` = the overlay must keep the mouse; `editing` = the region picker owns the keyboard too.
  const editing = picker !== null
  const capture = editing || (whale?.interacting ?? false)
  const hit = JSON.stringify({ rects, capture, editing })
  if (hit === lastHit) return
  lastHit = hit
  send({ type: 'hit', rects, capture, editing })
}, 16)
