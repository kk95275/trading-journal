// Funded-challenge rule sets for the replay backtester.
//
// A rule set is pure data (RULE_SETS below), so adding another firm or account
// size is one object — no new engine or UI code. RuleRuntime turns that data into
// the live state the session HUD renders and the engine enforces.
//
// Everything is measured on EQUITY (balance + floating P&L), because that's how
// the firms measure it: an open loser can breach the account before you close it.
import type { Direction } from './types'
import { specFor } from './symbols'
import { riskUsd } from './gold'

export type RuleStageId = 'step1' | 'step2' | 'funded'
export type DailyLossBasis = 'initialBalance' | 'startOfDayEquity'
export type AssetClass = 'fx' | 'metals' | 'indices' | 'energies' | 'crypto'
export type BreachKind = 'daily' | 'maxdd' | 'margin' | 'weekend'
export type RuleOutcome = 'running' | 'passed' | 'failed'

export interface RuleStage {
  id: RuleStageId
  name: string
  /** % of the stage's starting balance. 0 = no target (funded). */
  profitTargetPct: number
  /** % of initial balance. Overridable per session — see RuleOverrides. */
  maxDrawdownPct: number
  minTradingDays: number
  /**
   * Overrides the rule set's weekendFlat for this stage. FTMO, for instance,
   * only restricts holding through market breaks once you're funded — the
   * Challenge and Verification phases are free to hold over a weekend.
   */
  weekendFlat?: boolean
  /**
   * Set only where the firm's own pages disagree about this stage's drawdown.
   * The setup screen then offers the choice instead of picking silently;
   * maxDrawdownPct stays the default, and should be the stricter reading.
   */
  maxDrawdownChoices?: number[]
  /** Stage-only conditions worth showing in the setup panel. */
  notes?: string[]
}

export interface RuleSet {
  id: string
  name: string
  firm: string
  accountSize: number
  stages: RuleStage[]
  dailyLossPct: number
  dailyLossBasis: DailyLossBasis
  /**
   * What the day's floor is measured down FROM, captured at the daily reset.
   * IC measures from end-of-day equity; FTMO is explicit that it uses the
   * account BALANCE at 00:00, which ignores a position's floating loss and so
   * leaves the floor higher than an equity baseline would.
   */
  dailyBaseline: 'balance' | 'equity'
  /**
   * True where the firm states a percentage without saying what it applies to,
   * so the setup screen offers both readings rather than guessing.
   */
  dailyBasisAmbiguous?: boolean
  /** Server timezone for the 00:00 daily reset, both with EU DST. */
  serverTz: 'eet' | 'cet' | 'utc'
  maxDrawdownTrailing: boolean
  /** Margin in use must stay under this % of equity, or the account hard-breaches. */
  marginExposureMaxPct?: number
  /** Required only when marginExposureMaxPct is set — that's the only thing it feeds. */
  leverage?: Record<AssetClass, number>
  /** Omit where the firm's commission varies by instrument; the field stays editable. */
  commissionPerLot?: number
  allowHedging: boolean
  /** Positions must be flat before Friday close. */
  weekendFlat: boolean
  /** Friday UTC time by which you must be flat, in seconds from midnight. */
  weekendFlatUtcSec: number
  /** Soft guideline: risk per trade idea. Warns, never breaches. */
  softRiskPerIdeaPct?: number
  /** A "profitable day" closes net at or above this % of starting balance. */
  profitableDayPct?: number
  /** Rules that exist but this simulator can't check — shown in the setup panel. */
  unsimulated: string[]
}

export interface RuleOverrides {
  maxDrawdownPct?: number
  dailyLossBasis?: DailyLossBasis
}

/** What a session carries so its rule set survives in SessionConfig. */
export interface SessionRules {
  ruleSetId: string
  stageId: RuleStageId
  overrides: RuleOverrides
}

export interface RuleBreach {
  kind: BreachKind
  title: string
  detail: string
  time: number
  equity: number
}

/* ---------------- presets ---------------- */

export const IC_FUNDED_25K: RuleSet = {
  id: 'ic-2step-pro-25k',
  name: 'IC Funded — 2-Step Professional 25K',
  firm: 'IC Funded',
  accountSize: 25000,
  stages: [
    {
      id: 'step1',
      name: 'Step 1',
      profitTargetPct: 10,
      // The rules page says 10%, the Help Centre says 8% for Step 1. Default to the
      // stricter reading: pass under 8% and you have passed under 10% either way.
      maxDrawdownPct: 8,
      maxDrawdownChoices: [8, 10],
      minTradingDays: 3,
      notes: ['News trading allowed', 'Step 1 profit does not carry into Step 2'],
    },
    {
      id: 'step2',
      name: 'Step 2',
      profitTargetPct: 5,
      maxDrawdownPct: 10,
      minTradingDays: 3,
      notes: ['News trading allowed', 'Starts again from the original balance'],
    },
    {
      id: 'funded',
      name: 'Funded (simulated)',
      profitTargetPct: 0,
      maxDrawdownPct: 10,
      minTradingDays: 0,
      notes: [
        'No opening or closing within 3 minutes either side of high-impact news',
        'First payout needs 14 calendar days and 5 profitable days (+0.5% each)',
      ],
    },
  ],
  dailyLossPct: 5,
  // "$1,250 on $25K" reads as a fixed 5% of the initial balance, measured down from
  // the previous end-of-day equity. Switchable per session — see RuleOverrides.
  dailyLossBasis: 'initialBalance',
  // "measured against end-of-day equity" — the floor hangs off equity, not balance.
  dailyBaseline: 'equity',
  dailyBasisAmbiguous: true,
  serverTz: 'eet',
  maxDrawdownTrailing: false,
  marginExposureMaxPct: 75,
  leverage: { fx: 50, metals: 20, indices: 20, energies: 20, crypto: 2 },
  commissionPerLot: 4,
  allowHedging: false,
  weekendFlat: true,
  weekendFlatUtcSec: 20 * 3600 + 55 * 60,
  softRiskPerIdeaPct: 1.5,
  profitableDayPct: 0.5,
  unsimulated: [
    'High-impact news blackout (funded stage) — the app has no economic calendar',
    'Consistency clause: lot size, frequency and risk exposure must stay comparable',
    'No martingale or grid averaging, copy trading, rented EAs, HFT or latency arbitrage',
    '30 consecutive calendar days of inactivity terminates the account',
    'Heavy profit concentration in a single trade can trigger a manual review',
  ],
}

/**
 * FTMO FTMO Challenge: 2-Step, $25,000. Read from ftmo.com's Trading Objectives
 * and FAQ pages, October 2026.
 *
 * Differs from IC in ways that matter to a backtest: the daily floor is measured
 * from the BALANCE at 00:00 CE(S)T rather than equity, hedging is allowed, there
 * is no margin-exposure rule, and the news and market-break restrictions apply
 * only once you are funded — the Challenge and Verification phases may hold over
 * a weekend and trade straight through news.
 */
export const FTMO_2STEP_25K: RuleSet = {
  id: 'ftmo-2step-25k',
  name: 'FTMO — 2-Step Challenge 25K',
  firm: 'FTMO',
  accountSize: 25000,
  stages: [
    {
      id: 'step1',
      name: 'FTMO Challenge',
      profitTargetPct: 10,
      maxDrawdownPct: 10,
      minTradingDays: 4,
      weekendFlat: false,
      notes: [
        'News trading and weekend holding both allowed in this phase',
        'No time limit, and no consistency rule on the 2-Step',
      ],
    },
    {
      id: 'step2',
      name: 'Verification',
      profitTargetPct: 5,
      maxDrawdownPct: 10,
      minTradingDays: 4,
      weekendFlat: false,
      notes: [
        'News trading and weekend holding both allowed in this phase',
        'Starts again from the original balance',
      ],
    },
    {
      id: 'funded',
      name: 'FTMO Account',
      profitTargetPct: 0,
      maxDrawdownPct: 10,
      minTradingDays: 0,
      weekendFlat: true,
      notes: [
        'No holding through any market break longer than 2 hours',
        'No order execution within 2 minutes either side of a restricted news release',
      ],
    },
  ],
  dailyLossPct: 5,
  dailyLossBasis: 'initialBalance',
  // "the account balance recorded at 00:00 CE(S)T of the current day minus 5% of
  // the Initial Simulated Capital" — a floating loss held over midnight does not
  // drag the next day's floor down with it.
  dailyBaseline: 'balance',
  serverTz: 'cet',
  maxDrawdownTrailing: false,
  allowHedging: true,
  weekendFlat: false,
  // Friday close is 23:50 server time (GMT+3 on the platform) = 20:50 UTC.
  weekendFlatUtcSec: 20 * 3600 + 50 * 60,
  unsimulated: [
    'Overnight swaps — FTMO counts them in equity, and they add up when you hold for days',
    'Margin requirements and stop-out (Standard leverage is 1:100 forex, 1:50 gold)',
    'Commission varies by instrument: $5/lot on forex, 0.0014% of volume on gold — set it per session',
    'Funded stage: the 2-minute news blackout, since the app has no economic calendar',
    'Funded stage: the break rule covers any closure over 2 hours, not only weekends',
    'Forbidden Trading Practices — tick scalping, latency arbitrage, opposite positions across accounts',
  ],
}

export const RULE_SETS: RuleSet[] = [IC_FUNDED_25K, FTMO_2STEP_25K]

export function ruleSetById(id: string | undefined): RuleSet | null {
  if (!id || id === 'none') return null
  return RULE_SETS.find(r => r.id === id) ?? null
}

export function stageOf(rules: RuleSet, id: RuleStageId): RuleStage {
  return rules.stages.find(s => s.id === id) ?? rules.stages[0]
}

/* ---------------- instrument helpers ---------------- */

const CRYPTO = /^(BTC|ETH|LTC|XRP|SOL|ADA|DOGE|BNB|DOT|AVAX)/
const ENERGY = /^(WTI|BRENT|XTI|XBR|USOIL|UKOIL|NGAS|XNG)/
const INDEX = /^(US30|US100|US500|US2000|NAS|SPX|DJI|GER|DAX|UK100|FTSE|JP225|NIK|AUS200|HK50|EU50|STOXX|FRA40|ESP35)/

export function assetClassFor(symbol: string): AssetClass {
  const s = symbol.toUpperCase()
  if (CRYPTO.test(s)) return 'crypto'
  if (ENERGY.test(s)) return 'energies'
  if (INDEX.test(s)) return 'indices'
  if (/^(XAU|XAG|XPT|XPD)/.test(s)) return 'metals'
  return 'fx'
}

/** Position size in USD: lots x contract size x price, converted from the quote currency. */
export function notionalUsd(symbol: string, lots: number, price: number): number {
  const spec = specFor(symbol)
  return lots * spec.contractSize * price * (spec.quoteToUsd ?? 1)
}

export function marginUsdFor(rules: RuleSet, symbol: string, lots: number, price: number): number {
  const lev = rules.leverage?.[assetClassFor(symbol)] ?? 1
  return notionalUsd(symbol, lots, price) / lev
}

/* ---------------- server time ---------------- */

/** 01:00 UTC on the last Sunday of a month — the EU DST switch moment. */
function lastSundayUtc(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0))
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  d.setUTCHours(1, 0, 0, 0)
  return d.getTime() / 1000
}

/** True from the last Sunday of March to the last Sunday of October (EU summer time). */
export function isEuDst(ts: number): boolean {
  const y = new Date(ts * 1000).getUTCFullYear()
  return ts >= lastSundayUtc(y, 2) && ts < lastSundayUtc(y, 9)
}

/** EET/EEST: UTC+2 in winter, UTC+3 in summer. */
export function eetOffsetHours(ts: number): number {
  return isEuDst(ts) ? 3 : 2
}

/** CET/CEST: UTC+1 in winter, UTC+2 in summer. */
export function cetOffsetHours(ts: number): number {
  return isEuDst(ts) ? 2 : 1
}

export function serverOffsetHours(rules: RuleSet, ts: number): number {
  if (rules.serverTz === 'eet') return eetOffsetHours(ts)
  if (rules.serverTz === 'cet') return cetOffsetHours(ts)
  return 0
}

/** Which server-time calendar day a UTC timestamp falls in. */
export function serverDayIndex(rules: RuleSet, ts: number): number {
  return Math.floor((ts + serverOffsetHours(rules, ts) * 3600) / 86400)
}

/** The next Friday weekend-flat deadline at or after ts, in UTC seconds. */
export function nextWeekendDeadline(rules: RuleSet, ts: number): number {
  const dayStart = Math.floor(ts / 86400) * 86400
  const dow = new Date(dayStart * 1000).getUTCDay() // 0 Sun … 5 Fri
  const daysToFri = (5 - dow + 7) % 7
  let deadline = dayStart + daysToFri * 86400 + rules.weekendFlatUtcSec
  if (deadline < ts) deadline += 7 * 86400
  return deadline
}

/* ---------------- live state ---------------- */

export interface RuleStatus {
  rules: RuleSet
  stage: RuleStage
  initialBalance: number
  balance: number
  equity: number
  dayStartEquity: number
  dailyLimit: number
  dailyFloor: number
  dailyUsed: number
  dailyLeft: number
  maxFloor: number
  maxLimit: number
  maxUsed: number
  maxLeft: number
  targetUsd: number
  profitUsd: number
  targetLeft: number
  targetPct: number
  tradingDays: number
  minTradingDays: number
  profitableDays: number
  riskFlags: number
  marginUsed: number
  marginLimit: number
  weekendDeadline: number | null
  secondsToWeekend: number | null
  outcome: RuleOutcome
  breach: RuleBreach | null
  overridden: boolean
}

export interface OrderCheck {
  ok: boolean
  error?: string
  warning?: string
  /** True when the warning is the soft per-idea risk guideline, which the HUD counts. */
  riskFlag?: boolean
}

export interface SyncInput {
  ts: number
  balance: number
  equity: number
  /**
   * Worst equity reached inside this bar (longs marked to the low, shorts to the
   * high). The firms measure continuously, so a wick through the floor breaches
   * even if the bar closes back above it. Defaults to equity.
   */
  equityLow?: number
  marginUsed: number
  openPositions: number
}

export type SyncResult = 'breach' | 'passed' | null

const EPS = 0.005

/**
 * A RuleRuntime flattened to something Dexie can hold, so one attempt can span
 * several replay sessions. Only mutable state lives here — the rule set, stage
 * and overrides come back from the attempt's SessionRules.
 */
export interface RuleRuntimeState {
  balance: number
  equity: number
  marginUsed: number
  peakEquity: number
  troughEquity: number
  dayKey: number
  dayStartEquity: number
  /** Balance at the daily reset. Absent on rows written before FTMO was added. */
  dayStartBalance?: number
  dayRealized: number
  /** tradingDays as a plain array — a Set doesn't survive structured cloning in IDB. */
  tradingDays: number[]
  profitableDays: number
  riskFlags: number
  outcome: RuleOutcome
  breach: RuleBreach | null
  overridden: boolean
  lastTs: number
}

/**
 * Tracks one challenge attempt. The engine calls sync() on every simulated minute
 * and the panels read status() — no React state in here, the engine's own notify()
 * already drives re-renders.
 */
export class RuleRuntime {
  readonly rules: RuleSet
  readonly stage: RuleStage
  readonly initialBalance: number
  readonly maxDrawdownPct: number
  readonly dailyLossBasis: DailyLossBasis

  balance: number
  equity: number
  marginUsed = 0
  peakEquity: number
  /** Deepest equity the attempt ever touched. Recorded only — no rule reads it. */
  troughEquity: number
  dayKey = 0
  dayStartEquity: number
  dayStartBalance: number
  dayRealized = 0
  tradingDays = new Set<number>()
  profitableDays = 0
  riskFlags = 0
  outcome: RuleOutcome = 'running'
  breach: RuleBreach | null = null
  /** Set when the trader chooses to keep going past a breach, for practice. */
  overridden = false
  lastTs = 0

  constructor(rules: RuleSet, stageId: RuleStageId, initialBalance: number, overrides: RuleOverrides = {}) {
    this.rules = rules
    this.stage = stageOf(rules, stageId)
    this.initialBalance = initialBalance
    this.maxDrawdownPct = overrides.maxDrawdownPct ?? this.stage.maxDrawdownPct
    this.dailyLossBasis = overrides.dailyLossBasis ?? rules.dailyLossBasis
    this.balance = initialBalance
    this.equity = initialBalance
    this.dayStartBalance = initialBalance
    this.peakEquity = initialBalance
    this.troughEquity = initialBalance
    this.dayStartEquity = initialBalance
  }

  /** Rebuild a runtime mid-attempt from a stored row. */
  static fromState(rules: RuleSet, sr: SessionRules, initialBalance: number, s: RuleRuntimeState): RuleRuntime {
    const r = new RuleRuntime(rules, sr.stageId, initialBalance, sr.overrides)
    r.balance = s.balance
    r.equity = s.equity
    r.marginUsed = s.marginUsed
    r.peakEquity = s.peakEquity
    r.troughEquity = s.troughEquity
    r.dayKey = s.dayKey
    r.dayStartEquity = s.dayStartEquity
    r.dayStartBalance = s.dayStartBalance ?? s.dayStartEquity
    r.dayRealized = s.dayRealized
    r.tradingDays = new Set(s.tradingDays)
    r.profitableDays = s.profitableDays
    r.riskFlags = s.riskFlags
    r.outcome = s.outcome
    r.breach = s.breach
    r.overridden = s.overridden
    r.lastTs = s.lastTs
    return r
  }

  toJSON(): RuleRuntimeState {
    return {
      balance: this.balance,
      equity: this.equity,
      marginUsed: this.marginUsed,
      peakEquity: this.peakEquity,
      troughEquity: this.troughEquity,
      dayKey: this.dayKey,
      dayStartEquity: this.dayStartEquity,
      dayStartBalance: this.dayStartBalance,
      dayRealized: this.dayRealized,
      tradingDays: [...this.tradingDays],
      profitableDays: this.profitableDays,
      riskFlags: this.riskFlags,
      outcome: this.outcome,
      breach: this.breach ? { ...this.breach } : null,
      overridden: this.overridden,
      lastTs: this.lastTs,
    }
  }

  /** What today's floor is measured down from — balance or equity at the reset. */
  get dayStart(): number {
    return this.rules.dailyBaseline === 'balance' ? this.dayStartBalance : this.dayStartEquity
  }

  get dailyLimit(): number {
    const base = this.dailyLossBasis === 'initialBalance' ? this.initialBalance : this.dayStart
    return base * this.rules.dailyLossPct / 100
  }

  get dailyFloor(): number {
    return this.dayStart - this.dailyLimit
  }

  /** The stage can turn the weekend rule on or off independently of the firm default. */
  get weekendFlat(): boolean {
    return this.stage.weekendFlat ?? this.rules.weekendFlat
  }

  get maxLimit(): number {
    return this.initialBalance * this.maxDrawdownPct / 100
  }

  get maxFloor(): number {
    return this.rules.maxDrawdownTrailing
      ? this.peakEquity - this.maxLimit
      : this.initialBalance - this.maxLimit
  }

  get targetUsd(): number {
    return this.initialBalance * this.stage.profitTargetPct / 100
  }

  get marginLimit(): number {
    return this.rules.marginExposureMaxPct ? this.equity * this.rules.marginExposureMaxPct / 100 : Infinity
  }

  /** The firm counts days on which you actually opened a trade. */
  noteTradeOpened(ts: number) {
    this.tradingDays.add(serverDayIndex(this.rules, ts))
  }

  noteTradeClosed(pnl: number) {
    this.dayRealized += pnl
  }

  noteRiskFlag() {
    this.riskFlags++
  }

  /** Called once per simulated minute. Returns what changed, if anything. */
  sync(i: SyncInput): SyncResult {
    const { ts, balance, equity, marginUsed, openPositions } = i
    const low = i.equityLow ?? equity
    this.balance = balance
    this.equity = equity
    this.marginUsed = marginUsed
    if (equity > this.peakEquity) this.peakEquity = equity
    if (low < this.troughEquity) this.troughEquity = low

    const key = serverDayIndex(this.rules, ts)
    if (this.dayKey === 0) {
      // First sync of the run: the day opened on the untouched starting balance,
      // whatever has happened by the time this is first called.
      this.dayKey = key
      this.dayStartEquity = this.initialBalance
      this.dayStartBalance = this.initialBalance
    } else if (key !== this.dayKey) {
      const pct = this.rules.profitableDayPct
      if (pct && this.dayRealized >= this.initialBalance * pct / 100 - EPS) this.profitableDays++
      this.dayKey = key
      // A new day's baseline is where the previous day ended — equity for IC,
      // balance for FTMO, which ignores a position's floating loss at midnight.
      this.dayStartEquity = equity
      this.dayStartBalance = balance
      this.dayRealized = 0
    }

    const prevTs = this.lastTs
    this.lastTs = ts
    if (this.outcome !== 'running' || this.overridden) return null

    if (low < this.maxFloor - EPS) {
      return this.fail({
        kind: 'maxdd',
        title: 'Max drawdown breached',
        detail: `Equity ${usd(low)} fell below the ${this.maxDrawdownPct}% floor of ${usd(this.maxFloor)}. That floor is static — it never moves up with profit.`,
        time: ts,
        equity,
      })
    }
    if (low < this.dailyFloor - EPS) {
      return this.fail({
        kind: 'daily',
        title: 'Daily loss limit breached',
        detail: `Equity ${usd(low)} fell below today's floor of ${usd(this.dailyFloor)} — ${usd(this.dailyLimit)} under the ${usd(this.dayStart)} you opened the day on. Floating losses count.`,
        time: ts,
        equity,
      })
    }
    if (marginUsed > this.marginLimit + EPS) {
      return this.fail({
        kind: 'margin',
        title: 'Margin exposure breached',
        detail: `Margin in use ${usd(marginUsed)} is over ${this.rules.marginExposureMaxPct}% of equity (${usd(this.marginLimit)}).`,
        time: ts,
        equity,
      })
    }
    if (this.weekendFlat && openPositions > 0 && prevTs > 0) {
      // Either the clock crossed Friday's cut-off, or the feed jumped the weekend.
      const crossed = ts >= nextWeekendDeadline(this.rules, prevTs)
      const jumped = ts - prevTs > 12 * 3600 && isFriday(prevTs)
      if (crossed || jumped) {
        return this.fail({
          kind: 'weekend',
          title: 'Weekend holding breached',
          detail: `${openPositions} position${openPositions > 1 ? 's were' : ' was'} still open at the Friday close. Everything has to be flat before the weekend.`,
          time: ts,
          equity,
        })
      }
    }

    if (
      this.stage.profitTargetPct > 0 &&
      openPositions === 0 &&
      balance >= this.initialBalance + this.targetUsd - EPS &&
      this.tradingDays.size >= this.stage.minTradingDays
    ) {
      this.outcome = 'passed'
      return 'passed'
    }
    return null
  }

  private fail(b: RuleBreach): SyncResult {
    this.breach = b
    this.outcome = 'failed'
    return 'breach'
  }

  /** Keep trading after a breach, for practice. The run stays marked failed. */
  override() {
    this.overridden = true
  }

  /** Pre-trade gate. The engine refuses the order when ok is false. */
  checkOrder(o: {
    symbol: string
    direction: Direction
    lots: number
    price: number
    sl?: number
    equity: number
    openDirections: Direction[]
    ts: number
  }): OrderCheck {
    if (this.outcome === 'failed' && !this.overridden) {
      return { ok: false, error: 'Account breached — this challenge run is over.' }
    }
    if (!this.rules.allowHedging && o.openDirections.some(d => d !== o.direction)) {
      return { ok: false, error: 'Hedging is prohibited — close the opposite position first.' }
    }
    const addMargin = marginUsdFor(this.rules, o.symbol, o.lots, o.price)
    if (this.rules.marginExposureMaxPct) {
      const limit = o.equity * this.rules.marginExposureMaxPct / 100
      if (this.marginUsed + addMargin > limit + EPS) {
        const lev = this.rules.leverage?.[assetClassFor(o.symbol)] ?? 1
        return {
          ok: false,
          error: `Margin would reach ${usd(this.marginUsed + addMargin)} against a ${usd(limit)} cap (${this.rules.marginExposureMaxPct}% of equity at 1:${lev}). Reduce size.`,
        }
      }
    }
    let warning: string | undefined
    let riskFlag = false
    const softPct = this.rules.softRiskPerIdeaPct
    if (softPct) {
      if (o.sl === undefined) {
        warning = `No stop loss — the ${softPct}% per-idea guideline can't be checked, and floating losses count toward the daily limit.`
      } else {
        const risk = riskUsd(o.direction, o.price, o.sl, o.lots, o.symbol)
        const cap = o.equity * softPct / 100
        if (risk > cap + EPS) {
          riskFlag = true
          warning = `Risk ${usd(risk)} is over the ${softPct}% per-idea guideline (${usd(cap)}). Not a breach, but it can trigger a risk review — and splitting one idea across orders doesn't reset it.`
        }
      }
    }
    if (!warning && this.weekendFlat) {
      const left = nextWeekendDeadline(this.rules, o.ts) - o.ts
      if (left < 4 * 3600) {
        warning = `Friday close is in ${Math.max(0, Math.round(left / 60))} min — you have to be flat before the weekend.`
      }
    }
    return { ok: true, warning, riskFlag }
  }

  status(): RuleStatus {
    const dailyUsed = Math.max(0, this.dayStart - this.equity)
    const maxUsed = Math.max(0, (this.rules.maxDrawdownTrailing ? this.peakEquity : this.initialBalance) - this.equity)
    const profitUsd = this.balance - this.initialBalance
    const weekendDeadline = this.weekendFlat && this.lastTs ? nextWeekendDeadline(this.rules, this.lastTs) : null
    return {
      rules: this.rules,
      stage: this.stage,
      initialBalance: this.initialBalance,
      balance: this.balance,
      equity: this.equity,
      dayStartEquity: this.dayStart,
      dailyLimit: this.dailyLimit,
      dailyFloor: this.dailyFloor,
      dailyUsed,
      dailyLeft: Math.max(0, this.dailyLimit - dailyUsed),
      maxFloor: this.maxFloor,
      maxLimit: this.maxLimit,
      maxUsed,
      maxLeft: Math.max(0, this.maxLimit - maxUsed),
      targetUsd: this.targetUsd,
      profitUsd,
      targetLeft: Math.max(0, this.targetUsd - profitUsd),
      targetPct: this.targetUsd > 0 ? Math.max(0, Math.min(1, profitUsd / this.targetUsd)) : 1,
      tradingDays: this.tradingDays.size,
      minTradingDays: this.stage.minTradingDays,
      profitableDays: this.profitableDays,
      riskFlags: this.riskFlags,
      marginUsed: this.marginUsed,
      marginLimit: this.marginLimit,
      weekendDeadline,
      secondsToWeekend: weekendDeadline ? weekendDeadline - this.lastTs : null,
      outcome: this.outcome,
      breach: this.breach,
      overridden: this.overridden,
    }
  }
}

function isFriday(ts: number): boolean {
  return new Date(ts * 1000).getUTCDay() === 5
}

function usd(v: number): string {
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
