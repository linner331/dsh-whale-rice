/**
 * What the agent is doing right now, derived from persisted session events, plus one-shot outcomes.
 *
 *   ask         – an approval question is waiting for the user   (approval/asked … approval/decided)
 *   generating  – a model call is producing tokens               (step/start … assistant/message)
 *   tool        – tools requested by that call are running       (assistant/message … step/end)
 *   idle        – nothing in flight
 *
 * Outcomes are reported once per finished turn: `oops` (error), `full` (max-tokens), and
 * `cheer` (a long turn completed, so the user may want to come back).
 */

export type Activity = 'idle' | 'generating' | 'tool' | 'ask'
export type OutcomeKind = 'oops' | 'full' | 'cheer'
export interface Outcome { kind: OutcomeKind; seq: number }

const RANK: Record<Activity, number> = { idle: 0, tool: 1, generating: 2, ask: 3 }
const DOWNGRADE_GRACE_MS = 1500   // short gaps (between steps, quick tools) don't flicker the pet
export const CHEER_AFTER_MS = 20_000     // only long turns are worth a "done!" celebration

interface SessionState {
  phase: 'idle' | 'generating' | 'tool'
  approvals: Set<string>
  turnStartedAt: number
}

export class ActivityTracker {
  private readonly sessions = new Map<string, SessionState>()
  private published: Activity = 'idle'
  private downgradeTimer: ReturnType<typeof setTimeout> | undefined
  private outcomeSeq = 0
  private lastOutcome: Outcome | null = null
  private readonly listeners = new Set<() => void>()

  /** A turn finished (any outcome), with how long it took: she earns bait for it. */
  onTurnEnd: ((ms: number) => void) | undefined

  get activity(): Activity { return this.published }
  get outcome(): Outcome | null { return this.lastOutcome }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  onSessionEvent(sessionId: string, event: { type?: string; data?: any }): void {
    const s = this.session(sessionId)
    switch (event.type) {
      case 'turn/start': s.turnStartedAt = Date.now(); break
      case 'step/start': s.phase = 'generating'; break
      case 'assistant/message': s.phase = 'tool'; break
      case 'step/end': s.phase = 'idle'; break
      case 'approval/asked': s.approvals.add(String(event.data?.id)); break
      case 'approval/decided': s.approvals.delete(String(event.data?.id)); break
      case 'turn/end':
        this.finishTurn(s, event.data?.reason?.kind)
        this.sessions.delete(sessionId)
        break
      default: return
    }
    this.sync()
  }

  dispose(): void {
    clearTimeout(this.downgradeTimer)
    this.listeners.clear()
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) this.sessions.set(id, s = { phase: 'idle', approvals: new Set(), turnStartedAt: Date.now() })
    return s
  }

  private finishTurn(s: SessionState, reason: string | undefined): void {
    const kind: OutcomeKind | null =
      reason === 'error' ? 'oops'
      : reason === 'max-tokens' ? 'full'
      : reason === 'completed' && Date.now() - s.turnStartedAt >= CHEER_AFTER_MS ? 'cheer'
      : null
    if (kind) this.lastOutcome = { kind, seq: ++this.outcomeSeq }
    this.onTurnEnd?.(Date.now() - s.turnStartedAt)
  }

  /** Highest-ranked activity across sessions. */
  private raw(): Activity {
    let best: Activity = 'idle'
    for (const s of this.sessions.values()) {
      const a: Activity = s.approvals.size > 0 ? 'ask' : s.phase
      if (RANK[a] > RANK[best]) best = a
    }
    return best
  }

  private sync(): void {
    const next = this.raw()
    if (RANK[next] >= RANK[this.published]) {
      clearTimeout(this.downgradeTimer)
      this.downgradeTimer = undefined
      this.publish(next)
    } else if (this.downgradeTimer === undefined) {
      this.downgradeTimer = setTimeout(() => { this.downgradeTimer = undefined; this.publish(this.raw()) }, DOWNGRADE_GRACE_MS)
    }
    // Outcomes are delivered even when the activity itself doesn't change.
    this.emit()
  }

  private publish(next: Activity): void {
    if (this.published === next) return
    this.published = next
    this.emit()
  }

  private emit(): void { for (const fn of this.listeners) fn() }
}
