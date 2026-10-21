/**
 * The hole she smashes into the screen to go fishing. Nothing on screen is captured: the glass is
 * painted art drawn light-on-black and turned transparent (assets/treasure), so it reads as broken
 * glass over whatever is underneath.
 *
 * Through the hole is a seaside seen in depth (the beach art, cut to the hole's shape by its mask).
 * She walks in over the lower rim, getting smaller toward the shore, jumps into the sea and comes
 * back the same way. `stage` holds her small double, clipped by the hole; positions on it are
 * fractions of the opening (SHORE, NEAR below).
 *
 *   crack()   – a spider-web crack spreads from the impact
 *   shatter() – shards burst out and fall, the rim and the beach appear, water spouts up
 *   splashAt() / ripple() / bubbleAt() – the sea answering her
 *   restore() – the shards fly back, the beach goes, the crack flashes and heals
 */
import { BEACH, HOLE } from './treasure-art.ts'

/** Depth lines, as fractions of the opening from its top: where sand meets water, the rim she steps over. */
export const SHORE = BEACH.shore
export const NEAR = 0.93
const SHARDS = 11
const SHATTER_MS = 750

export class SeaHole {
  readonly el = document.createElement('div')
  /** Where things inside the scene go (her double, splashes); clipped by the hole. */
  readonly stage = document.createElement('div')
  private readonly scene = document.createElement('div')
  private readonly crackEl = document.createElement('div')
  private readonly rim = document.createElement('div')
  private readonly flights: Animation[] = []
  private readonly glass: DOMRect

  /** `box`: the hole's opening, a square in layer px. The glass art around it is larger. */
  constructor(private readonly layer: HTMLElement, private readonly box: DOMRect) {
    // The opening covers HOLE (fractions) of the glass image; size and place the glass to match.
    const g = box.width / (HOLE.right - HOLE.left)
    this.glass = new DOMRect(box.x - HOLE.left * g, box.y - HOLE.top * g, g, g)
    this.el.className = 'wr-hole'
    place(this.el, this.glass)
    this.scene.className = 'wr-scene'
    place(this.scene, new DOMRect(box.x - this.glass.x, box.y - this.glass.y, box.width, box.height))
    // The mask is drawn over the whole glass image: shift it so its opening lands on the scene.
    this.scene.style.setProperty('--mask-size', `${g}px`)
    this.scene.style.setProperty('--mask-pos', `${-HOLE.left * g}px ${-HOLE.top * g}px`)
    this.stage.className = 'wr-stage'
    this.scene.append(this.stage)
    this.crackEl.className = 'wr-glass wr-glass-crack'
    this.rim.className = 'wr-glass wr-glass-rim'
    this.el.append(this.scene, this.rim, this.crackEl)
    layer.append(this.el)
  }

  crack(): void {
    this.crackEl.animate([
      { opacity: 1, clipPath: 'circle(0% at 50% 50%)' },
      { opacity: 1, clipPath: 'circle(75% at 50% 50%)' },
    ], { duration: 220, easing: 'ease-out', fill: 'forwards' })
    shake(this.layer, 3)
  }

  async shatter(): Promise<void> {
    shake(this.layer, 4)
    const g = this.glass.width
    this.flights.push(
      this.crackEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }),
      this.rim.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 160, fill: 'forwards' }),
      this.scene.animate([{ opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1 }], { duration: 260, easing: 'ease-out', fill: 'forwards' }),
    )
    // Shards from the shard sheet burst out of the opening, spin and fall away.
    for (let i = 0; i < SHARDS; i++) {
      const s = document.createElement('i')
      s.className = 'wr-shard'
      const size = g * (0.12 + Math.random() * 0.12)
      const cell = Math.floor(Math.random() * 9)
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.22
      const cx = 0.5 + Math.cos(a) * r, cy = 0.5 + Math.sin(a) * r
      Object.assign(s.style, { left: `${cx * g - size / 2}px`, top: `${cy * g - size / 2}px`, width: `${size}px`, height: `${size}px` })
      s.style.setProperty('--cell', `${(cell % 3) * 50}% ${Math.floor(cell / 3) * 50}%`)
      this.el.append(s)
      const out = g * (0.35 + Math.random() * 0.4), spin = (Math.random() - 0.5) * 720, tilt = Math.random() * 360
      const dx = Math.cos(a) * out, dy = Math.sin(a) * out * 0.6
      this.flights.push(s.animate([
        { transform: `translate(0, 0) rotate(${tilt}deg) scale(0.6)`, opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6 - g * 0.15}px) rotate(${tilt + spin * 0.4}deg) scale(1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${dy + g * 0.9}px) rotate(${tilt + spin}deg) scale(1)`, opacity: 0 },
      ], { duration: SHATTER_MS + Math.random() * 250, easing: 'cubic-bezier(.3,.1,.7,1)', fill: 'forwards' }))
    }
    this.spout()
    await settle(this.flights, SHATTER_MS + 300)
  }

  /** Rings spreading on the water at (fx, fy) opening fractions; `k`: how near (sizes them). */
  ripple(fx: number, fy: number, k: number): void {
    this.put('wr-ripple', fx, fy, k)
  }

  /** Water thrown up where she goes in or comes out. */
  splashAt(fx: number, fy: number, k: number): void {
    this.put('wr-splash', fx, fy, k)
    this.ripple(fx, fy, k)
    for (let i = 0; i < 9; i++) {
      const d = this.put('wr-spray', fx, fy, k)
      const vx = (Math.random() - 0.5) * 70 * k, up = (30 + Math.random() * 45) * k
      d.animate([
        { translate: '-50% -50%' },
        { translate: `calc(-50% + ${vx * 0.5}px) calc(-50% - ${up}px)`, offset: 0.45, easing: 'ease-in' },
        { translate: `calc(-50% + ${vx}px) calc(-50% + 4px)`, opacity: 0.2 },
      ], { duration: 600 + Math.random() * 250, easing: 'ease-out', fill: 'forwards' }).finished.then(() => d.remove(), () => d.remove())
    }
  }

  /** An air bubble breaking the surface where she is under. */
  bubbleAt(fx: number, fy: number, k: number): void {
    this.put('wr-bubble-air', fx + (Math.random() - 0.5) * 0.04, fy, k)
  }

  async restore(): Promise<void> {
    for (const f of this.flights) f.reverse()
    await settle(this.flights, SHATTER_MS + 300)
    // Whole again: the crack flashes once and is gone.
    const heal = this.crackEl.animate([{ opacity: 0, filter: 'brightness(1)' }, { opacity: 1, filter: 'brightness(1.8)', offset: 0.3 }, { opacity: 0 }], { duration: 480, fill: 'forwards' })
    await settle([heal], 500)
    this.remove()
  }

  /** Gone at once (interrupted): a quick fade instead of the full reverse. */
  dismiss(): void {
    this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => this.remove(), () => this.remove())
  }

  remove(): void { this.el.remove() }

  private put(cls: string, fx: number, fy: number, k: number): HTMLElement {
    const S = this.box.width
    const e = document.createElement('i')
    e.className = cls
    Object.assign(e.style, { left: `${fx * S}px`, top: `${fy * S}px` })
    e.style.setProperty('--k', String(k))
    this.stage.append(e)
    if (cls !== 'wr-spray') e.addEventListener('animationend', () => e.remove())
    return e
  }

  /** Water drops thrown up out of the hole; some land on the screen and leave a drop that dries. */
  private spout(count = 22): void {
    const S = this.box.width
    const ox = this.box.x + S / 2, oy = this.box.y + S / 2
    for (let i = 0; i < count; i++) {
      const d = document.createElement('i')
      d.className = 'wr-drop'
      const size = 4 + Math.random() * 6
      Object.assign(d.style, { left: `${ox}px`, top: `${oy}px`, width: `${size}px`, height: `${size}px` })
      this.layer.append(d)
      const vx = (Math.random() - 0.5) * S * 1.6, up = S * (0.6 + Math.random() * 0.9), fall = S * (0.3 + Math.random() * 0.6)
      const t = 650 + Math.random() * 350
      const flight = d.animate([
        { transform: 'translate(-50%, -50%)' },
        { transform: `translate(calc(-50% + ${vx * 0.5}px), calc(-50% - ${up}px))`, offset: 0.45, easing: 'ease-in' },
        { transform: `translate(calc(-50% + ${vx}px), calc(-50% + ${fall - up * 0.3}px))` },
      ], { duration: t, easing: 'ease-out', fill: 'forwards' })
      const lands = Math.random() < 0.35
      flight.finished.then(() => {
        if (!lands) return d.remove()
        d.classList.add('wr-stain')
        d.animate([{ opacity: 0.7 }, { opacity: 0 }], { duration: 3500, delay: 600, fill: 'forwards' }).finished.then(() => d.remove(), () => d.remove())
      }, () => d.remove())
    }
  }
}

/** Animations finished, or `ms` passed — a page in the background never runs them, and the scene must not hang. */
function settle(anims: Animation[], ms: number): Promise<unknown> {
  return Promise.race([Promise.all(anims.map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, ms))])
}

function place(el: HTMLElement, r: DOMRect): void {
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
}

function shake(layer: HTMLElement, amp: number): void {
  layer.animate([0, amp, -amp, amp * 0.6, -amp * 0.4, 0].map(x => ({ translate: `${x}px ${-x * 0.5}px` })), { duration: 220 })
}
