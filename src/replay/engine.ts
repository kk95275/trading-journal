// Bar-replay engine. Holds a growing window of 1m bars, a cursor (idx), and the
// open position. Every 1m advance checks SL/TP fills at 1-minute granularity,
// regardless of the viewing timeframe. Prices are BID; buys fill at bid + spread.
// If SL and TP are both touched inside the same 1m bar, SL wins (conservative).
import type { Bar, Confirmation, Direction, ExitReason, Trade } from '../lib/types'
import { pnlUsd, riskUsd } from '../lib/gold'
import { specFor } from '../lib/symbols'
import * as data from '../data/dataService'
import type { Drawing } from './drawings'

export interface SessionConfig {
  accountId: number
  accountName: string
  symbol: string
  startTs: number
  spread: number
  commissionPerLot: number // round-turn, per lot
  startingBalance: number
}

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
  onTradeClosed: ((t: Trade) => void) | null = null

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
    return eng
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn()
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

  placeMarketOrder(o: {
    direction: Direction
    lots: number
    sl?: number
    tp?: number
    setupId?: number
    confirmations: Confirmation[]
    notes: string
  }) {
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
    this.notify()
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
    this.sessionTrades.push(trade)
    this.onTradeClosed?.(trade)
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
