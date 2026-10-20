/**
 * The whale's emotional state: three numbers instead of a growing pile of rules.
 *
 *   valence  v ∈ [-1, 1]   unhappy … happy
 *   arousal  a ∈ [-1, 1]   drained / sleepy … worked up
 *   need     n ∈ [ 0, 1]   wants your attention (raised by finishing a task, cleared by praise)
 *
 * Every interaction is an *impulse* (Δv, Δa, Δn) from one table (EVENTS); the values then decay
 * back to 0 on their own (exponential, half-lives below). The visible mood is just a region of
 * that space (moodOf). Stacking, relief and replacement fall out of the arithmetic:
 *   - two face-plants add up → a deeper, longer sulk
 *   - a nice event while sulking only moves her part of the way back
 *   - a bad event during a good mood flips her straight into the negative regions
 * New behaviour = a new row in EVENTS (and maybe a region); nothing else changes.
 */

export type Mood = 'sulk' | 'wary' | 'gloom' | 'smug' | 'expect' | 'sleepy'

export type EmotionEvent =
  | 'grab' | 'struggle' | 'faceplant' | 'stuck' | 'error' | 'stuffed' | 'taskDone' | 'eat' | 'praise' | 'annoy' | 'comfort'

/** [Δvalence, Δarousal, Δneed] per event. Tune here; behaviour follows. */
export const EVENTS: Record<EmotionEvent, [number, number, number]> = {
  grab:      [-0.05, +0.20,  0.00],   // picked up by the scruff
  struggle:  [-0.25, +0.20,  0.00],   // one bout of struggling while held
  faceplant: [-0.70, +0.60,  0.00],   // thrown and landed on her face
  stuck:     [+0.35, +0.50,  0.00],   // thrown and landed like a gymnast
  error:     [-0.40, -0.30,  0.00],   // the turn failed
  stuffed:   [ 0.00, -0.80,  0.00],   // ran out of tokens: too full
  taskDone:  [+0.40, -0.10, +0.80],   // a long task finished: look what I did!
  eat:       [+0.06,  0.00,  0.00],   // per second of eating while the model generates
  praise:    [+0.30, +0.10, -1.00],   // clicked while in a good mood: attention received
  annoy:     [-0.08, +0.12,  0.00],   // clicked while upset and worked up
  comfort:   [+0.15,  0.00,  0.00],   // clicked while upset and low
}

const HALF_LIFE_S = { v: 15, a: 12, n: 40 }

/** Regions of the (v, a, n) space, checked in order. */
export function moodOf(v: number, a: number, n: number): Mood | null {
  if (a <= -0.5) return 'sleepy'
  if (v <= -0.5 && a >= 0.25) return 'sulk'      // very upset and worked up
  if (v <= -0.15 && a >= 0.25) return 'wary'     // upset and on guard
  if (v <= -0.15 && a <= -0.1) return 'gloom'    // upset and drained
  if (n >= 0.4 && v >= 0) return 'expect'        // happy and waiting to be noticed
  if (v >= 0.25 && a >= 0.25) return 'smug'      // happy and excited
  return null
}

const clamp = (x: number): number => Math.max(-1, Math.min(1, x))

export class Emotion {
  private v = 0
  private a = 0
  private n = 0
  private at = performance.now()

  /** Apply decay up to now. */
  private settle(now = performance.now()): void {
    const dt = (now - this.at) / 1000
    this.at = now
    this.v *= 0.5 ** (dt / HALF_LIFE_S.v)
    this.a *= 0.5 ** (dt / HALF_LIFE_S.a)
    this.n *= 0.5 ** (dt / HALF_LIFE_S.n)
  }

  feel(event: EmotionEvent, times = 1): Mood | null {
    this.settle()
    const [dv, da, dn] = EVENTS[event]
    this.v = clamp(this.v + dv * times)
    this.a = clamp(this.a + da * times)
    this.n = Math.max(0, Math.min(1, this.n + dn * times))
    return this.mood
  }

  /** Back to neutral (director mode). */
  reset(): void {
    this.v = this.a = this.n = 0
    this.at = performance.now()
  }

  /** What a click means right now: praise when happy, comfort when low, annoyance when worked up. */
  poke(): Mood | null {
    this.settle()
    if (this.v >= 0) return this.feel('praise')
    return this.feel(this.a >= 0.25 ? 'annoy' : 'comfort')
  }

  get mood(): Mood | null {
    this.settle()
    return moodOf(this.v, this.a, this.n)
  }

  get valence(): number { this.settle(); return this.v }

  /** For the dev harness. */
  get state(): { v: number; a: number; n: number; mood: Mood | null } {
    this.settle()
    return { v: +this.v.toFixed(2), a: +this.a.toFixed(2), n: +this.n.toFixed(2), mood: moodOf(this.v, this.a, this.n) }
  }
}
