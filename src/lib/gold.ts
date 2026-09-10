// Contract math + formatting. Data prices are BID; buys fill at ask = bid + spread.
// Contract size comes from the symbol spec (gold: 100 oz/lot, FX: 100k units/lot).
// For pairs whose QUOTE currency isn't USD (JPY-quoted like GBPJPY, base-USD like
// USDCHF, EUR crosses, etc.), spec.quoteToUsd converts raw P&L to USD.
import type { Direction } from './types'
import { specFor } from './symbols'

export function pnlUsd(direction: Direction, entry: number, exit: number, lots: number, symbol: string): number {
  const move = direction === 'long' ? exit - entry : entry - exit
  const spec = specFor(symbol)
  return move * spec.contractSize * lots * (spec.quoteToUsd ?? 1)
}

export function riskUsd(direction: Direction, entry: number, sl: number, lots: number, symbol: string): number {
  const dist = direction === 'long' ? entry - sl : sl - entry
  const spec = specFor(symbol)
  return Math.max(0, dist) * spec.contractSize * lots * (spec.quoteToUsd ?? 1)
}

export const fmtUsd = (v: number, digits = 2) =>
  (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const fmtPrice = (v: number) => v.toFixed(2)

export const fmtR = (v: number | undefined) => (v === undefined || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)

export const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`

const pad = (n: number) => String(n).padStart(2, '0')

// All timestamps in the dataset are GMT (no DST) — format with UTC getters.
export function fmtDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function fmtDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

export function dateToDayStr(ts: number): string {
  return fmtDate(ts)
}
