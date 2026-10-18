// Persistence for one funded-challenge attempt.
//
// The ReplayEngine lives in memory and dies with the page, but a 2-step
// evaluation runs over weeks. AttemptStore is the thin layer that keeps the
// attempt's row in Dexie roughly in step with the running RuleRuntime, so the
// setup screen can offer it back as "Resume".
//
// Writes are throttled: syncRules fires every simulated minute, which at 16
// bars/s on a 4h chart is hundreds of calls a second. Nothing here is on the
// hot path — touch() only sets a flag, and the state is serialised lazily at
// flush time, so the row always holds a consistent snapshot of *now*, never a
// stale one queued earlier.
import { db, type ChallengeAttempt } from '../db'
import { ruleSetById, stageOf, type RuleRuntimeState, type SessionRules } from '../lib/propRules'

const SAVE_THROTTLE_MS = 1500

export interface AttemptSnapshot {
  resumeTs: number
  state: RuleRuntimeState
}

export interface AttemptSeed {
  accountId: number
  accountName: string
  symbol: string
  spread: number
  commissionPerLot: number
  rules: SessionRules
  startingBalance: number
  startTs: number
}

export async function createAttempt(seed: AttemptSeed, snap: AttemptSnapshot): Promise<number> {
  const now = Date.now()
  return (await db.challengeAttempts.add({
    ...seed,
    resumeTs: snap.resumeTs,
    state: snap.state,
    outcome: snap.state.outcome,
    createdAt: now,
    updatedAt: now,
  })) as number
}

export async function deleteAttempt(id: number): Promise<void> {
  await db.challengeAttempts.delete(id)
}

export class AttemptStore {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private disposed = false

  constructor(readonly id: number, private readonly snapshot: () => AttemptSnapshot) {}

  /** Mark the attempt changed. Pass true for the moments worth not losing. */
  touch(immediate = false) {
    if (this.disposed) return
    this.dirty = true
    if (immediate) { void this.flush(); return }
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, SAVE_THROTTLE_MS)
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty) return
    this.dirty = false
    const snap = this.snapshot()
    try {
      await db.challengeAttempts.update(this.id, {
        resumeTs: snap.resumeTs,
        state: snap.state,
        outcome: snap.state.outcome,
        updatedAt: Date.now(),
      })
    } catch {
      // A failed write only costs the trader the resume point, never the session.
    }
  }

  /** Last write, then stop. Called when the session ends. */
  async dispose(): Promise<void> {
    await this.flush()
    this.disposed = true
  }
}

/* ---------------- reading ---------------- */

export interface AttemptSummary {
  /** Best the account was ever up, measured on equity, not just closed trades. */
  peakProfit: number
  /** Deepest it was ever down. Same basis as the breach checks: worst intrabar equity. */
  worstDrawdown: number
  tradingDays: number
  profit: number
  breachTitle: string | null
  breachDetail: string | null
  stageName: string
  ruleSetName: string
  /** False once a rule set is removed from the app — the attempt can't be rebuilt. */
  known: boolean
}

export function summarizeAttempt(a: ChallengeAttempt): AttemptSummary {
  const s = a.state
  const rs = ruleSetById(a.rules.ruleSetId)
  return {
    peakProfit: Math.max(0, s.peakEquity - a.startingBalance),
    worstDrawdown: Math.max(0, a.startingBalance - s.troughEquity),
    tradingDays: s.tradingDays.length,
    profit: s.balance - a.startingBalance,
    breachTitle: s.breach?.title ?? null,
    breachDetail: s.breach?.detail ?? null,
    stageName: rs ? stageOf(rs, a.rules.stageId).name : a.rules.stageId,
    ruleSetName: rs?.name ?? 'Unknown rule set',
    known: !!rs,
  }
}

/** Newest activity first — the one you most likely want to carry on with. */
export function sortAttempts(rows: ChallengeAttempt[]): ChallengeAttempt[] {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
}
