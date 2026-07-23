import type { Trade } from './types'

export interface Summary {
  n: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  netPnl: number
  grossWin: number
  grossLoss: number
  profitFactor: number
  expectancy: number
  avgWin: number
  avgLoss: number
  bestTrade: number
  worstTrade: number
  totalR: number
  avgR: number
  maxDrawdown: number
  currentStreak: number // + wins, - losses
  maxWinStreak: number
  maxLossStreak: number
  avgDurationSec: number
}

export function summarize(tradesIn: Trade[]): Summary {
  const trades = [...tradesIn].sort((a, b) => a.exitTime - b.exitTime)
  const n = trades.length
  let wins = 0, losses = 0, breakeven = 0
  let grossWin = 0, grossLoss = 0
  let best = 0, worst = 0
  let totalR = 0, rCount = 0
  let equity = 0, peak = 0, maxDD = 0
  let streak = 0, maxWinStreak = 0, maxLossStreak = 0
  let durSum = 0

  for (const t of trades) {
    if (t.pnl > 0) { wins++; grossWin += t.pnl } else if (t.pnl < 0) { losses++; grossLoss += -t.pnl } else breakeven++
    if (t.pnl > best) best = t.pnl
    if (t.pnl < worst) worst = t.pnl
    if (t.rMultiple !== undefined && isFinite(t.rMultiple)) { totalR += t.rMultiple; rCount++ }
    equity += t.pnl
    if (equity > peak) peak = equity
    if (peak - equity > maxDD) maxDD = peak - equity
    if (t.pnl > 0) streak = streak > 0 ? streak + 1 : 1
    else if (t.pnl < 0) streak = streak < 0 ? streak - 1 : -1
    if (streak > maxWinStreak) maxWinStreak = streak
    if (-streak > maxLossStreak) maxLossStreak = -streak
    durSum += Math.max(0, t.exitTime - t.entryTime)
  }

  return {
    n, wins, losses, breakeven,
    winRate: n ? wins / n : 0,
    netPnl: grossWin - grossLoss,
    grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: n ? (grossWin - grossLoss) / n : 0,
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: losses ? grossLoss / losses : 0,
    bestTrade: best, worstTrade: worst,
    totalR, avgR: rCount ? totalR / rCount : 0,
    maxDrawdown: maxDD,
    currentStreak: streak, maxWinStreak, maxLossStreak,
    avgDurationSec: n ? durSum / n : 0,
  }
}

export interface EquityPoint { i: number; time: number; equity: number }

export function equityCurve(tradesIn: Trade[]): EquityPoint[] {
  const trades = [...tradesIn].sort((a, b) => a.exitTime - b.exitTime)
  let eq = 0
  return trades.map((t, i) => { eq += t.pnl; return { i: i + 1, time: t.exitTime, equity: +eq.toFixed(2) } })
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}

export interface BucketStat { key: string; n: number; pnl: number; winRate: number }

export function bucketStats(trades: Trade[], key: (t: Trade) => string): BucketStat[] {
  return [...groupBy(trades, key).entries()].map(([k, ts]) => ({
    key: k,
    n: ts.length,
    pnl: +ts.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    winRate: ts.length ? ts.filter(t => t.pnl > 0).length / ts.length : 0,
  }))
}

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function dayOfWeek(ts: number): string {
  return DOW[new Date(ts * 1000).getUTCDay()]
}

export function hourOfDay(ts: number): string {
  return String(new Date(ts * 1000).getUTCHours()).padStart(2, '0')
}
