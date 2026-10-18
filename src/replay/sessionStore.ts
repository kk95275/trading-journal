// Persistence for a replay session.
//
// The ReplayEngine lives in memory and dies with the page, but a backtest can
// run for weeks of simulated time and a funded evaluation for weeks of real
// ones. This is the thin layer that keeps a session's row in Dexie roughly in
// step with the running engine, so the setup screen can offer it back as
// "Resume". Every session gets a row; a funded-challenge attempt additionally
// carries its serialised RuleRuntime.
//
// Writes are throttled: syncRules fires every simulated minute, which at 16
// bars/s on a 4h chart is hundreds of calls a second. Nothing here is on the
// hot path — touch() only sets a flag, and the state is serialised lazily at
// flush time, so the row always holds a consistent snapshot of *now*, never a
// stale one queued earlier.
import { db, type BacktestSession } from '../db'
import { ruleSetById, stageOf, type RuleRuntimeState, type SessionRules } from '../lib/propRules'

const SAVE_THROTTLE_MS = 1500

export interface SessionSnapshot {
  resumeTs: number
  balance: number
  /** Null for a plain backtest — there is no rule tracker to serialise. */
  state: RuleRuntimeState | null
}

export interface SessionSeed {
  accountId: number
  accountName: string
  symbol: string
  spread: number
  commissionPerLot: number
  rules: SessionRules | null
  startingBalance: number
  startTs: number
}

export async function createSession(seed: SessionSeed, snap: SessionSnapshot): Promise<number> {
  const now = Date.now()
  return (await db.challengeAttempts.add({
    ...seed,
    resumeTs: snap.resumeTs,
    balance: snap.balance,
    state: snap.state,
    outcome: snap.state?.outcome ?? 'running',
    createdAt: now,
    updatedAt: now,
  })) as number
}

export async function deleteSession(id: number): Promise<void> {
  await db.transaction('rw', db.challengeAttempts, db.trades, async () => {
    await db.challengeAttempts.delete(id)
    // The trades stay in the journal; they just stop pointing at a session.
    await db.trades.where('sessionId').equals(id).modify({ sessionId: undefined })
  })
}

export class SessionStore {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private disposed = false

  constructor(readonly id: number, private readonly snapshot: () => SessionSnapshot) {}

  /** Mark the session changed. Pass true for the moments worth not losing. */
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
        balance: snap.balance,
        state: snap.state,
        outcome: snap.state?.outcome ?? 'running',
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

export interface SessionSummary {
  /** Best the account was ever up, on equity, not just closed trades. */
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
  /** True for a plain backtest with no rule set attached. */
  plain: boolean
}

export function summarizeSession(a: BacktestSession): SessionSummary {
  const s = a.state
  const rs = a.rules ? ruleSetById(a.rules.ruleSetId) : null
  if (!a.rules || !s) {
    return {
      peakProfit: Math.max(0, a.balance - a.startingBalance),
      worstDrawdown: Math.max(0, a.startingBalance - a.balance),
      tradingDays: 0,
      profit: a.balance - a.startingBalance,
      breachTitle: null,
      breachDetail: null,
      stageName: 'Backtest',
      ruleSetName: 'No rules',
      known: true,
      plain: true,
    }
  }
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
    plain: false,
  }
}

/** Newest activity first — the one you most likely want to carry on with. */
export function sortSessions(rows: BacktestSession[]): BacktestSession[] {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
}
