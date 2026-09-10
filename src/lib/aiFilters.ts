// Trade filters applied inside the Analyze modal, on top of whatever filter
// state the calling page (Trades / Analytics / Backtest) already applied.
// Kept separate from src/pages/Trades.tsx's own filter state on purpose —
// the caller passes in a slice, this narrows further per-analysis.

import type { Trade } from './types'
import { sessionLabel, dayOfWeek } from './stats'

export interface TradeFilters {
  dateFrom?: number    // epoch seconds, entryTime lower bound (inclusive)
  dateTo?: number      // epoch seconds, entryTime upper bound (inclusive)
  symbols: string[]    // empty = all
  setupIds: (number | 'none')[] // 'none' means "no setup assigned"; empty = all
  direction: 'all' | 'long' | 'short'
  result: 'all' | 'win' | 'loss' | 'breakeven'
  grades: string[]     // e.g. ['A','B','Ungraded']; empty = all
  sessions: string[]   // 'Asian' | 'London' | 'New York' | 'Off-hours'
  daysOfWeek: string[] // 'Sun','Mon',... (matches stats.DOW)
  exitReasons: string[] // 'sl' | 'tp' | 'manual' | 'other'
}

export const EMPTY_FILTERS: TradeFilters = {
  symbols: [], setupIds: [], direction: 'all', result: 'all',
  grades: [], sessions: [], daysOfWeek: [], exitReasons: [],
}

export function applyFilters(trades: Trade[], f: TradeFilters): Trade[] {
  return trades.filter(t => {
    if (f.dateFrom !== undefined && t.entryTime < f.dateFrom) return false
    if (f.dateTo !== undefined && t.entryTime > f.dateTo) return false
    if (f.symbols.length && !f.symbols.includes(t.symbol)) return false
    if (f.setupIds.length) {
      const key: number | 'none' = t.setupId ?? 'none'
      if (!f.setupIds.includes(key)) return false
    }
    if (f.direction !== 'all' && t.direction !== f.direction) return false
    if (f.result === 'win' && !(t.pnl > 0)) return false
    if (f.result === 'loss' && !(t.pnl < 0)) return false
    if (f.result === 'breakeven' && t.pnl !== 0) return false
    if (f.grades.length) {
      const g = t.grade ?? 'Ungraded'
      if (!f.grades.includes(g)) return false
    }
    if (f.sessions.length && !f.sessions.includes(sessionLabel(t.entryTime))) return false
    if (f.daysOfWeek.length && !f.daysOfWeek.includes(dayOfWeek(t.entryTime))) return false
    if (f.exitReasons.length && !f.exitReasons.includes(t.exitReason)) return false
    return true
  })
}

/** True if any filter narrows the input. */
export function hasActiveFilters(f: TradeFilters): boolean {
  return (
    f.dateFrom !== undefined || f.dateTo !== undefined ||
    f.symbols.length > 0 || f.setupIds.length > 0 ||
    f.direction !== 'all' || f.result !== 'all' ||
    f.grades.length > 0 || f.sessions.length > 0 ||
    f.daysOfWeek.length > 0 || f.exitReasons.length > 0
  )
}

/** Human-readable summary of the currently active filters, for the AI prompt scope. */
export function describeFilters(f: TradeFilters, setupNameById: Map<number, string>): string {
  const bits: string[] = []
  if (f.dateFrom !== undefined || f.dateTo !== undefined) {
    const from = f.dateFrom !== undefined ? isoDate(f.dateFrom) : '…'
    const to = f.dateTo !== undefined ? isoDate(f.dateTo) : '…'
    bits.push(`date ${from} → ${to}`)
  }
  if (f.symbols.length) bits.push(`symbols=${f.symbols.join(',')}`)
  if (f.setupIds.length) {
    const names = f.setupIds.map(id => id === 'none' ? '(no setup)' : (setupNameById.get(id as number) ?? `#${id}`))
    bits.push(`setups=${names.join(',')}`)
  }
  if (f.direction !== 'all') bits.push(`dir=${f.direction}`)
  if (f.result !== 'all') bits.push(`result=${f.result}`)
  if (f.grades.length) bits.push(`grades=${f.grades.join(',')}`)
  if (f.sessions.length) bits.push(`sessions=${f.sessions.join(',')}`)
  if (f.daysOfWeek.length) bits.push(`days=${f.daysOfWeek.join(',')}`)
  if (f.exitReasons.length) bits.push(`exit=${f.exitReasons.join(',')}`)
  return bits.length ? ` (filtered: ${bits.join('; ')})` : ''
}

function isoDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** UTC date-input string ("YYYY-MM-DD") ↔ epoch seconds (start of day UTC). */
export function toEpochStartOfDay(dateStr: string): number | undefined {
  if (!dateStr) return undefined
  const d = new Date(`${dateStr}T00:00:00Z`)
  const t = d.getTime()
  return isFinite(t) ? Math.floor(t / 1000) : undefined
}
export function toEpochEndOfDay(dateStr: string): number | undefined {
  if (!dateStr) return undefined
  const d = new Date(`${dateStr}T23:59:59Z`)
  const t = d.getTime()
  return isFinite(t) ? Math.floor(t / 1000) : undefined
}
export function epochToDateInput(ts: number | undefined): string {
  if (ts === undefined) return ''
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
