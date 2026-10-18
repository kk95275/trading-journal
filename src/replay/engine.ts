// Bar-replay engine. Holds a growing window of 1m bars, a cursor (idx), and the
// open position. Every 1m advance checks SL/TP fills at 1-minute granularity,
// regardless of the viewing timeframe. Prices are BID; buys fill at bid + spread.
// If SL and TP are both touched inside the same 1m bar, SL wins (conservative).
import type { Bar, Confirmation, Direction, ExitReason, Trade } from '../lib/types'
import { pnlUsd, riskUsd } from '../lib/gold'
import { specFor } from '../lib/symbols'
import { RuleRuntime, marginUsdFor, ruleSetById, type OrderCheck, type RuleRuntimeState, type SessionRules } from '../lib/propRules'
import * as data from '../data/dataService'
import { SessionStore, createSession } from './sessionStore'
import type { Drawing } from './drawings'

export interface SessionConfig {
  accountId: number
  accountName: string
  symbol: string
  startTs: number
  spread: number
  commissionPerLot: number // round-turn, per lot
  startingBalance: number
  /** Funded-challenge rule set to enforce. Absent = plain backtesting, no rules. */
  rules?: SessionRules
  /**
   * Set when picking a saved session back up: the engine rebuilds the rule
   * tracker from this state and keeps writing to the same row instead of
   * opening a new attempt. Positions aren't carried — a resumed session starts
   * flat on the realized balance.
   */
  resume?: { sessionId: number; balance: number; state: RuleRuntimeState | null }
}

export type RuleEvent = 'breach' | 'passed'

export interface OpenPosition {
  id: number
  direction: Direction
  lots: number
  entryPrice: number
  entryTime: number
  sl?: number
  tp?: number
  setupId?: number
  confirmations: Confirmation[]
  notes: string
}

const CONTEXT_DAYS = 45
const PREFETCH_MARGIN = 3000 // load next chunk when this close to the end

export class ReplayEngine {
  oneMin: Bar[] = []
  idx = 0
  config: SessionConfig
  balance: number
  positions: OpenPosition[] = []
  sessionTrades: Trade[] = []
  ended = false
  loadingMore = false
  drawings: Drawing[] = [] // chart drawings live on the session so they survive route changes
  /** Null for a plain backtest; otherwise tracks the challenge and gates orders. */
  rules: RuleRuntime | null = null
  /** Keeps this session's Dexie row in step so it can be resumed later. */
  store: SessionStore | null = null
  /** The saved session's row id, stamped onto every trade it produces. */
  sessionId: number | null = null
  onTradeClosed: ((t: Trade) => void) | null = null
  onRuleEvent: ((e: RuleEvent) => void) | null = null

  private nextChunkIdx = 0
  private totalChunks = 0
  private posSeq = 1
  private listeners = new Set<() => void>()

  private constructor(config: SessionConfig) {
    this.config = config
    this.balance = config.startingBalance
  }

  static async create(config: SessionConfig): Promise<ReplayEngine> {
    const eng = new ReplayEngine(config)
    const rs = ruleSetById(config.rules?.ruleSetId)
    if (rs && config.rules) {
      // A session saved without a rule set, then resumed with one, starts the
      // challenge fresh rather than inventing state it never had.
      eng.rules = config.resume?.state
        ? RuleRuntime.fromState(rs, config.rules, config.startingBalance, config.resume.state)
        : new RuleRuntime(rs, config.rules.stageId, config.startingBalance, config.rules.overrides)
    }
    // A resumed session carries on from the balance it stopped at, while
    // startingBalance stays the figure every rule limit is measured against.
    if (config.resume) eng.balance = config.resume.balance
    const chunks = await data.chunksFor(config.symbol, '1m')
    eng.totalChunks = chunks.length
    const from = config.startTs - CONTEXT_DAYS * 86400
    let firstIdx = chunks.findIndex(c => c.to >= from)
    if (firstIdx < 0) firstIdx = chunks.length - 1
    let lastIdx = chunks.findIndex(c => c.to >= config.startTs)
    if (lastIdx < 0) lastIdx = chunks.length - 1
    const bars = await data.getBars(config.symbol, '1m', chunks[firstIdx].from, chunks[lastIdx].to)
    eng.oneMin = bars
    eng.nextChunkIdx = lastIdx + 1
    // cursor: last bar at or before the requested start
    let i = bars.length - 1
    while (i > 0 && bars[i].time > config.startTs) i--
    eng.idx = Math.max(0, i)
    // Prime the rule tracker on the starting bar so the day's baseline is the
    // untouched starting balance, not whatever equity the first order leaves.
    eng.syncRules(eng.currentBar.time)
    const snapshot = () => ({
      resumeTs: eng.currentBar.time,
      balance: eng.balance,
      state: eng.rules ? eng.rules.toJSON() : null,
    })
    const id = config.resume?.sessionId ?? await createSession({
      accountId: config.accountId,
      accountName: config.accountName,
      symbol: config.symbol,
      spread: config.spread,
      commissionPerLot: config.commissionPerLot,
      rules: config.rules ?? null,
      startingBalance: config.startingBalance,
      startTs: config.startTs,
    }, snapshot())
    eng.sessionId = id
    eng.store = new SessionStore(id, snapshot)
    return eng
  }

  /** Flush the session row so the resume point is current. */
  async endSession(): Promise<void> {
    await this.store?.dispose()
    this.store = null
  }

  /** Keep trading past a breach, for practice. The attempt stays failed. */
  overrideBreach() {
    this.rules?.override()
    this.store?.touch(true)
    this.notify()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }

  /** Re-render subscribers after state changed outside the engine's own methods. */
  touch() {
    this.notify()
  }

  get currentBar(): Bar {
    return this.oneMin[this.idx]
  }

  get bid(): number {
    return this.currentBar.close
  }

  get ask(): number {
    return this.currentBar.close + this.config.spread
  }

  openPnl(p: OpenPosition): number {
    const exit = p.direction === 'long' ? this.bid : this.ask
    return pnlUsd(p.direction, p.entryPrice, exit, p.lots, this.config.symbol) - this.config.commissionPerLot * p.lots
  }

  openPnlTotal(): number {
    return this.positions.reduce((s, p) => s + this.openPnl(p), 0)
  }

  get equity(): number {
    return this.balance + this.openPnlTotal()
  }

  /** Margin in use across open positions, under the rule set's leverage tiers. */
  marginUsedUsd(): number {
    const r = this.rules
    if (!r) return 0
    return this.positions.reduce((s, p) => s + marginUsdFor(r.rules, this.config.symbol, p.lots, this.bid), 0)
  }

  /**
   * Worst equity reached inside a bar — longs marked to its low, shorts to its
   * high + spread. Prop firms measure drawdown continuously, so a wick through
   * the floor is a breach even when the bar closes back above it.
   */
  private worstEquityIn(bar: Bar): number {
    let eq = this.balance
    for (const p of this.positions) {
      const exit = p.direction === 'long' ? bar.low : bar.high + this.config.spread
      eq += pnlUsd(p.direction, p.entryPrice, exit, p.lots, this.config.symbol) - this.config.commissionPerLot * p.lots
    }
    return eq
  }

  /**
   * Feed the rule tracker. On a breach the firm disables the account, so we
   * flatten at market the way it would, and refuse further orders until the
   * trader explicitly chooses to keep going for practice.
   */
  private syncRules(ts: number, equityLow?: number) {
    const r = this.rules
    if (!r) return
    const res = r.sync({
      ts,
      balance: this.balance,
      equity: this.equity,
      equityLow,
      marginUsed: this.marginUsedUsd(),
      openPositions: this.positions.length,
    })
    if (res === 'breach') {
      for (const p of [...this.positions]) {
        this.fillExit(p, p.direction === 'long' ? this.bid : this.ask, 'other', ts)
      }
      r.balance = this.balance
      r.equity = this.balance
      r.marginUsed = 0
      this.onRuleEvent?.('breach')
    } else if (res === 'passed') {
      this.onRuleEvent?.('passed')
    }
    // Throttled on an ordinary minute; written straight away when the session
    // reaches its verdict, since that's the row the history list reads.
    this.store?.touch(res !== null)
  }

  /** Advance one 1m bar; returns false at the end of loaded data. */
  private advanceOne(): boolean {
    if (this.idx >= this.oneMin.length - 1) return false
    this.idx++
    const bar = this.oneMin[this.idx]
    if (this.positions.length) {
      const s = this.config.spread
      for (const p of [...this.positions]) {
        if (p.direction === 'long') {
          // exits sell at bid — the bar's raw prices
          if (p.sl !== undefined && bar.low <= p.sl) this.fillExit(p, p.sl, 'sl', bar.time)
          else if (p.tp !== undefined && bar.high >= p.tp) this.fillExit(p, p.tp, 'tp', bar.time)
        } else {
          // exits buy at ask = bid + spread
          if (p.sl !== undefined && bar.high + s >= p.sl) this.fillExit(p, p.sl, 'sl', bar.time)
          else if (p.tp !== undefined && bar.low + s <= p.tp) this.fillExit(p, p.tp, 'tp', bar.time)
        }
      }
    }
    this.syncRules(bar.time, this.worstEquityIn(bar))
    this.maybePrefetch()
    return true
  }

  /** Step forward one bar of the viewing timeframe (completes the next bucket). */
  step(tfSec: number): boolean {
    if (!this.advanceOne()) return false
    const bucket = Math.floor(this.currentBar.time / tfSec) * tfSec
    while (
      this.idx < this.oneMin.length - 1 &&
      Math.floor(this.oneMin[this.idx + 1].time / tfSec) * tfSec === bucket
    ) {
      if (!this.advanceOne()) break
    }
    this.notify()
    return true
  }

  /** Pre-trade rule check. Always ok when the session has no rule set. */
  checkOrder(o: { direction: Direction; lots: number; sl?: number }): OrderCheck {
    const r = this.rules
    if (!r) return { ok: true }
    return r.checkOrder({
      symbol: this.config.symbol,
      direction: o.direction,
      lots: o.lots,
      price: o.direction === 'long' ? this.ask : this.bid,
      sl: o.sl,
      equity: this.equity,
      openDirections: this.positions.map(p => p.direction),
      ts: this.currentBar.time,
    })
  }

  placeMarketOrder(o: {
    direction: Direction
    lots: number
    sl?: number
    tp?: number
    setupId?: number
    confirmations: Confirmation[]
    notes: string
  }): OrderCheck {
    const check = this.checkOrder(o)
    if (!check.ok) return check
    if (check.riskFlag) this.rules?.noteRiskFlag()
    const entry = o.direction === 'long' ? this.ask : this.bid
    this.positions.push({
      id: this.posSeq++,
      direction: o.direction,
      lots: o.lots,
      entryPrice: entry,
      entryTime: this.currentBar.time,
      sl: o.sl,
      tp: o.tp,
      setupId: o.setupId,
      confirmations: o.confirmations,
      notes: o.notes,
    })
    this.rules?.noteTradeOpened(this.currentBar.time)
    this.syncRules(this.currentBar.time)
    this.store?.touch(true)
    this.notify()
    return check
  }

  modifyStops(id: number, sl?: number, tp?: number) {
    const p = this.positions.find(x => x.id === id)
    if (!p) return
    p.sl = sl
    p.tp = tp
    this.notify()
  }

  updateNotes(id: number, notes: string) {
    const p = this.positions.find(x => x.id === id)
    if (p) p.notes = notes
  }

  closeManual(id: number) {
    const p = this.positions.find(x => x.id === id)
    if (!p) return
    const exit = p.direction === 'long' ? this.bid : this.ask
    this.fillExit(p, exit, 'manual', this.currentBar.time)
    this.syncRules(this.currentBar.time)
    this.notify()
  }

  private fillExit(p: OpenPosition, exitPrice: number, reason: ExitReason, exitTime: number) {
    this.positions = this.positions.filter(x => x.id !== p.id)
    const symbol = this.config.symbol
    const fees = this.config.commissionPerLot * p.lots
    const gross = pnlUsd(p.direction, p.entryPrice, exitPrice, p.lots, symbol)
    const pnl = +(gross - fees).toFixed(2)
    const risk = p.sl !== undefined ? riskUsd(p.direction, p.entryPrice, p.sl, p.lots, symbol) : undefined
    const px = specFor(symbol).decimals + 1
    const trade: Trade = {
      accountId: this.config.accountId,
      symbol,
      direction: p.direction,
      lots: p.lots,
      entryTime: p.entryTime,
      exitTime,
      entryPrice: +p.entryPrice.toFixed(px),
      exitPrice: +exitPrice.toFixed(px),
      sl: p.sl,
      tp: p.tp,
      pnl,
      fees,
      riskAmount: risk,
      rMultiple: risk && risk > 0 ? +(pnl / risk).toFixed(3) : undefined,
      exitReason: reason,
      setupId: p.setupId,
      confirmations: p.confirmations,
      mistakes: [],
      notes: p.notes,
      tags: [],
    }
    this.balance = +(this.balance + pnl).toFixed(2)
    this.rules?.noteTradeClosed(pnl)
    this.sessionTrades.push(trade)
    this.onTradeClosed?.(trade)
    this.store?.touch(true)
  }

  private maybePrefetch() {
    if (this.loadingMore) return
    if (this.idx < this.oneMin.length - PREFETCH_MARGIN) return
    if (this.nextChunkIdx >= this.totalChunks) {
      if (this.idx >= this.oneMin.length - 1) this.ended = true
      return
    }
    this.loadingMore = true
    data.chunksFor(this.config.symbol, '1m')
      .then(chunks => data.getBars(this.config.symbol, '1m', chunks[this.nextChunkIdx].from, chunks[this.nextChunkIdx].to))
      .then(bars => {
        this.oneMin.push(...bars)
        this.nextChunkIdx++
        this.loadingMore = false
        this.notify()
      })
      .catch(() => { this.loadingMore = false })
  }
}

// Survives route changes: the Backtest page re-attaches to the running session.
let active: ReplayEngine | null = null
export function getActiveEngine() { return active }
export function setActiveEngine(e: ReplayEngine | null) { active = e }

/**
 * Read-only view of a replay, satisfied by both ReplayEngine (drives the sim)
 * and MirrorEngine (renders a follower window). Shared components — ReplayChart,
 * DrawingLayer, SessionsLayer, OscPane — accept either through this shape.
 */
export interface IReplayView {
  config: SessionConfig
  oneMin: Bar[]
  idx: number
  positions: OpenPosition[]
  sessionTrades: Trade[]
  drawings: Drawing[]
  subscribe(fn: () => void): () => void
}
