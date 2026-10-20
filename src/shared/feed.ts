/** Shared mapping from host state snapshots to whale reactions (in-app and desktop overlay). */
import type { Whale } from './whale.ts'

export interface ScreenRect { x: number; y: number; w: number; h: number }

export type Activity = 'idle' | 'generating' | 'tool' | 'ask'

export interface WhaleState {
  activity: Activity
  /** Last one-shot turn outcome; `seq` increments every time a new one happens. */
  outcome: { kind: 'oops' | 'full' | 'cheer'; seq: number } | null
  /** Real balance from the DeepSeek API; null when it can't be read (then nothing is shown). */
  balance: number | null
  currency: string | null
  error: string | null
  /** The desktop overlay is running (the in-app whale steps aside). */
  overlay: boolean
  region: ScreenRect | null
  editing: boolean
  /** Director mode cue (demos/debugging); `seq` increments per cue. */
  director: { seq: number; act: string; arg: string | null } | null
}

/** Apply one snapshot. `last` is the previous one, or null right after (re)connecting. */
export function feed(whale: Whale, s: WhaleState, last: WhaleState | null): void {
  whale.setActivity(s.activity)
  // The first snapshot is only a baseline: never replay older events.
  if (!last) return
  if (s.outcome && s.outcome.seq !== last.outcome?.seq) whale.react(s.outcome.kind)
  if (s.director && s.director.seq !== last.director?.seq) whale.direct(s.director.act, s.director.arg)
}
