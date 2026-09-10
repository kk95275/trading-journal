// Read-only sibling of ReplayEngine. Loads the same 1-minute bar data from disk,
// but doesn't run its own simulation — the primary ReplayEngine (in the main
// backtest window) broadcasts snapshots via BroadcastChannel, and this mirror
// applies them. ReplayChart is happy to render either engine because it only
// reads the fields both classes expose.
//
// The class deliberately keeps the same public field shape as ReplayEngine so
// existing components (ReplayChart, DrawingLayer, SessionsLayer) don't need to
// know which engine they're driving.

import type { Bar, Trade } from '../lib/types'
import { pnlUsd } from '../lib/gold'
import * as data from '../data/dataService'
import type { Drawing } from './drawings'
import type { SessionConfig, OpenPosition } from './engine'
import type { EngineSnapshot } from './syncChannel'

const CONTEXT_DAYS = 45

export class MirrorEngine {
  oneMin: Bar[] = []
  idx = 0
  config: SessionConfig
  balance: number
  positions: OpenPosition[] = []
  sessionTrades: Trade[] = []
  ended = false
  loadingMore = false
  drawings: Drawing[] = []
  onTradeClosed: ((t: Trade) => void) | null = null // never fires here — mirror doesn't close trades

  private nextChunkIdx = 0
  private totalChunks = 0
  private listeners = new Set<() => void>()

  private constructor(config: SessionConfig) {
    this.config = config
    this.balance = config.startingBalance
  }

  static async create(config: SessionConfig): Promise<MirrorEngine> {
    const eng = new MirrorEngine(config)
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
    let i = bars.length - 1
    while (i > 0 && bars[i].time > config.startTs) i--
    eng.idx = Math.max(0, i)
    return eng
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }

  get currentBar(): Bar {
    return this.oneMin[this.idx] ?? this.oneMin[this.oneMin.length - 1]
  }
  get bid(): number { return this.currentBar.close }
  get ask(): number { return this.currentBar.close + this.config.spread }

  openPnl(p: OpenPosition): number {
    const exit = p.direction === 'long' ? this.bid : this.ask
    return pnlUsd(p.direction, p.entryPrice, exit, p.lots, this.config.symbol) - this.config.commissionPerLot * p.lots
  }
  openPnlTotal(): number {
    return this.positions.reduce((s, p) => s + this.openPnl(p), 0)
  }

  /** Apply a snapshot from the primary. Loads more bar data if needed. */
  async apply(snap: EngineSnapshot): Promise<void> {
    // If the primary has loaded more chunks than we have, catch up so idx
    // maps to a real bar. Guard against runaway loops if data is unavailable.
    while (this.oneMin.length < snap.oneMinCount && this.nextChunkIdx < this.totalChunks) {
      const nextIdx = this.nextChunkIdx
      this.loadingMore = true
      try {
        const chunks = await data.chunksFor(this.config.symbol, '1m')
        const bars = await data.getBars(this.config.symbol, '1m', chunks[nextIdx].from, chunks[nextIdx].to)
        this.oneMin.push(...bars)
        this.nextChunkIdx++
      } catch {
        break
      } finally {
        this.loadingMore = false
      }
    }
    this.idx = Math.min(snap.idx, this.oneMin.length - 1)
    this.positions = snap.positions
    this.sessionTrades = snap.sessionTrades
    // Only overwrite drawings if primary sent any (secondary can also draw locally
    // when the primary has none, without those being clobbered on the next tick).
    if (snap.drawings.length > 0 || this.drawings.length === 0) {
      this.drawings = snap.drawings
    }
    this.ended = snap.ended
    // Don't overwrite our own loadingMore state from the primary's — we manage ours above.
    this.balance = snap.balance
    this.notify()
  }
}
