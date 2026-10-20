/** The roaming area: a viewport-relative rectangle the user can move/resize. Persisted per browser. */

/** Where the whale may roam, in layer-local CSS px, and how the user changes it. */
export interface RegionSource {
  rect(): DOMRect
  /** Let the user change the area; resolves once she may go back to roaming. */
  edit(): Promise<void>
  /** Set the area directly (director mode), as viewport fractions. */
  set?(r: Rect): void
}

/** In-app area: a dashed frame inside the DSH window, stored in localStorage. */
export class LocalRegion implements RegionSource {
  private r = loadRegion()
  constructor(private readonly layer: HTMLElement) {}
  rect(): DOMRect { return regionPx(this.r) }
  async edit(): Promise<void> { this.r = await editRegion(this.layer, this.r) }
  set(r: Rect): void { this.r = r; saveRegion(r) }
}

export interface Rect { x: number; y: number; w: number; h: number }  // fractions of the viewport

const KEY = 'dsh-whale-rice:region'
const DEFAULT: Rect = { x: 0.48, y: 0.55, w: 0.5, h: 0.4 }
const MIN_PX = 160

export function loadRegion(): Rect {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Rect | null
    if (r && [r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && v >= 0 && v <= 1)) return r
  } catch { /* storage unavailable */ }
  return { ...DEFAULT }
}

function saveRegion(r: Rect): void {
  try { localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* ignore */ }
}

/** Region in CSS pixels for the current viewport. */
export function regionPx(r: Rect): DOMRect {
  const vw = window.innerWidth, vh = window.innerHeight
  return new DOMRect(r.x * vw, r.y * vh, Math.max(MIN_PX, r.w * vw), Math.max(MIN_PX, r.h * vh))
}

/**
 * Show a dashed, draggable/resizable frame over the region. Resolves with the new rect when the
 * user presses 完成 (or Escape).
 */
export function editRegion(layer: HTMLElement, current: Rect): Promise<Rect> {
  return new Promise(resolve => {
    const rect = { ...current }
    const frame = document.createElement('div')
    frame.className = 'wr-region'
    frame.innerHTML = '<span class="wr-region-hint">拖动移动 · 右下角缩放 · 鲸鱼娘只在框内活动</span>'
      + '<button class="wr-region-done" type="button">完成</button><div class="wr-region-resize"></div>'
    layer.append(frame)

    const render = (): void => {
      const px = regionPx(rect)
      Object.assign(frame.style, { left: `${px.x}px`, top: `${px.y}px`, width: `${px.width}px`, height: `${px.height}px` })
    }
    render()

    const clamp = (): void => {
      rect.w = Math.min(1, Math.max(MIN_PX / innerWidth, rect.w))
      rect.h = Math.min(1, Math.max(MIN_PX / innerHeight, rect.h))
      rect.x = Math.min(1 - rect.w, Math.max(0, rect.x))
      rect.y = Math.min(1 - rect.h, Math.max(0, rect.y))
    }

    let mode: 'move' | 'resize' | null = null
    let start = { px: 0, py: 0, r: rect }
    const onDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.wr-region-done')) return
      mode = target.classList.contains('wr-region-resize') ? 'resize' : 'move'
      start = { px: e.clientX, py: e.clientY, r: { ...rect } }
      frame.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = (e: PointerEvent): void => {
      if (!mode) return
      const dx = (e.clientX - start.px) / innerWidth, dy = (e.clientY - start.py) / innerHeight
      if (mode === 'move') { rect.x = start.r.x + dx; rect.y = start.r.y + dy }
      else { rect.w = start.r.w + dx; rect.h = start.r.h + dy }
      clamp(); render()
    }
    const onUp = (): void => { mode = null }
    const finish = (): void => {
      frame.remove()
      window.removeEventListener('keydown', onKey)
      saveRegion(rect)
      resolve(rect)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') finish() }

    frame.addEventListener('pointerdown', onDown)
    frame.addEventListener('pointermove', onMove)
    frame.addEventListener('pointerup', onUp)
    frame.querySelector('.wr-region-done')!.addEventListener('click', finish)
    window.addEventListener('keydown', onKey)
  })
}
