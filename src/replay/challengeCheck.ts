// Replays a finished set of trades through a funded-challenge rule set to answer
// "would this have passed?".
//
// The honest version of that question can't be answered from closed P&L alone.
// Both firms measure on EQUITY, so a strategy that sat 6% underwater at lunch
// and closed the day green has already breached — a balance-only check would
// call it a pass. So this walks the 1-minute bars the app already has, marks
// every open position to the worst price inside each bar, and feeds that to the
// same RuleRuntime the live replay uses. Same code path, same verdicts.
//
// Sizes are scaled by challenge balance / session balance, so a strategy tested
// on $10,000 is judged as if it had been run at the challenge's size with
// proportional risk. P&L, fees and risk are all linear in lots, so scaling the
// stored numbers is exact — no need to re-derive fills.
import type { Bar, Trade } from '../lib/types'
import { pnlUsd } from '../lib/gold'
import { specFor } from '../lib/symbols'
import {
  RuleRuntime,
  serverDayIndex,
  type RuleBreach,
  type RuleOverrides,
  type RuleSet,
  type RuleStageId,
} from '../lib/propRules'
import * as data from '../data/dataService'

/** Beyond this many simulated minutes the walk is refused rather than hanging. */
const MAX_MINUTES = 2_000_000

/** Where the 1-minute bars come from. Injectable so the walk can be tested. */
export type BarLoader = (symbol: string, from: number, to: number) => Promise<Bar[]>

const defaultLoader: BarLoader = (symbol, from, to) => data.getBars(symbol, '1m', from, to)

export interface CheckRequest {
  trades: Trade[]
  /** Balance the trades were actually produced on — the scaling denominator. */
  sessionBalance: number
  rules: RuleSet
  stageId: RuleStageId
  overrides?: RuleOverrides
  /** Spread per symbol, for marking shorts to the ask. Falls back to the spec. */
  spreadBySymbol?: Record<string, number>
  /** Defaults to the app's own bar store. */
  loadBars?: BarLoader
}

export type CheckOutcome = 'passed' | 'failed' | 'incomplete'

export interface StageVerdict {
  stageId: RuleStageId
  stageName: string
  outcome: CheckOutcome
  breach: RuleBreach | null
  /** When the breach happened, or the last bar walked. */
  endedAt: number
  scale: number
  startingBalance: number
  finalBalance: number
  profit: number
  targetUsd: number
  peakProfit: number
  worstDrawdown: number
  /** How close the worst moment came to each floor. Negative means it went through. */
  dailyRoomLeft: number
  maxRoomLeft: number
  tradingDays: number
  minTradingDays: number
  tradesUsed: number
  /** Set when the walk couldn't be completed — too long, or no bar data. */
  error: string | null
}

interface Lot {
  trade: Trade
  lots: number
  fees: number
  pnl: number
}

interface Feed {
  bars: Bar[]
  i: number
}

/** Last bar at or before t. Advances the cursor, so callers must walk forward. */
function barAt(f: Feed, t: number): Bar | null {
  while (f.i + 1 < f.bars.length && f.bars[f.i + 1].time <= t) f.i++
  const b = f.bars[f.i]
  return b && b.time <= t ? b : null
}

/**
 * Walk one stage. Returns a verdict rather than throwing, so a UI can show
 * three stages side by side even when one of them can't be computed.
 */
export async function checkStage(req: CheckRequest): Promise<StageVerdict> {
  const { rules, stageId, sessionBalance } = req
  const stage = rules.stages.find(s => s.id === stageId) ?? rules.stages[0]
  const size = rules.accountSize
  const scale = sessionBalance > 0 ? size / sessionBalance : 1
  const runtime = new RuleRuntime(rules, stageId, size, req.overrides ?? {})

  const base: StageVerdict = {
    stageId, stageName: stage.name, outcome: 'incomplete', breach: null, endedAt: 0,
    scale, startingBalance: size, finalBalance: size, profit: 0,
    targetUsd: runtime.targetUsd, peakProfit: 0, worstDrawdown: 0,
    dailyRoomLeft: 0, maxRoomLeft: 0,
    tradingDays: 0, minTradingDays: stage.minTradingDays,
    tradesUsed: 0, error: null,
  }

  const trades = req.trades
    .filter(t => t.entryTime && t.exitTime && t.exitTime >= t.entryTime)
    .sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime)
  if (!trades.length) return { ...base, error: 'No closed trades in this session.' }

  const start = trades[0].entryTime
  const end = trades.reduce((m, t) => Math.max(m, t.exitTime), start)

  // Load every symbol's bars across the span, once.
  const symbols = [...new Set(trades.map(t => t.symbol))]
  const load = req.loadBars ?? defaultLoader
  const feeds = new Map<string, Feed>()
  for (const sym of symbols) {
    try {
      const bars = await load(sym, start - 120, end + 120)
      if (!bars.length) return { ...base, error: `No 1-minute data for ${sym}.` }
      feeds.set(sym, { bars, i: 0 })
    } catch {
      return { ...base, error: `Couldn't load 1-minute data for ${sym}.` }
    }
  }

  const opens: { t: number; lot: Lot }[] = []
  const closes: { t: number; lot: Lot }[] = []
  for (const t of trades) {
    const lot: Lot = {
      trade: t,
      lots: t.lots * scale,
      fees: (t.fees ?? 0) * scale,
      pnl: t.pnl * scale,
    }
    opens.push({ t: t.entryTime, lot })
    closes.push({ t: t.exitTime, lot })
  }
  opens.sort((a, b) => a.t - b.t)
  closes.sort((a, b) => a.t - b.t)

  let balance = size
  let oi = 0
  let ci = 0
  const live = new Set<Lot>()
  let peakEquity = size
  let troughEquity = size
  let minDailyRoom = Infinity
  let minMaxRoom = Infinity
  let minutes = 0
  let t = start
  let lastTs = start

  const spreadFor = (sym: string) => req.spreadBySymbol?.[sym] ?? specFor(sym).defaultSpread

  /** Mark the book at time t. `worst` uses the bar's adverse extreme. */
  const equityAt = (now: number, worst: boolean): number => {
    let eq = balance
    for (const lot of live) {
      const f = feeds.get(lot.trade.symbol)
      const bar = f ? barAt(f, now) : null
      if (!bar) continue
      const dir = lot.trade.direction
      const sp = spreadFor(lot.trade.symbol)
      const px = dir === 'long'
        ? (worst ? bar.low : bar.close)
        : (worst ? bar.high : bar.close) + sp
      eq += pnlUsd(dir, lot.trade.entryPrice, px, lot.lots, lot.trade.symbol) - lot.fees
    }
    return eq
  }

  const nextDayBoundary = (now: number): number => {
    // Step forward to the first minute that lands in the next server day.
    const day = serverDayIndex(rules, now)
    let probe = now + 3600
    for (let guard = 0; guard < 48 && serverDayIndex(rules, probe) === day; guard++) probe += 3600
    // Back off to the minute the day actually turns.
    let lo = now, hi = probe
    while (hi - lo > 60) {
      const mid = Math.floor((lo + hi) / 2 / 60) * 60
      if (serverDayIndex(rules, mid) === day) lo = mid; else hi = mid
    }
    return hi
  }

  let boundary = nextDayBoundary(start)

  while (t <= end) {
    // Open everything that starts at or before t.
    while (oi < opens.length && opens[oi].t <= t) {
      live.add(opens[oi].lot)
      runtime.noteTradeOpened(opens[oi].t)
      oi++
    }
    // Close everything that ends at or before t, realising its P&L.
    while (ci < closes.length && closes[ci].t <= t) {
      const lot = closes[ci].lot
      if (live.delete(lot)) {
        balance = +(balance + lot.pnl).toFixed(2)
        runtime.noteTradeClosed(lot.pnl)
      }
      ci++
    }

    const equity = equityAt(t, false)
    const low = live.size ? equityAt(t, true) : equity
    peakEquity = Math.max(peakEquity, equity)
    troughEquity = Math.min(troughEquity, low)

    const res = runtime.sync({
      ts: t, balance, equity, equityLow: low, marginUsed: 0, openPositions: live.size,
    })
    minDailyRoom = Math.min(minDailyRoom, low - runtime.dailyFloor)
    minMaxRoom = Math.min(minMaxRoom, low - runtime.maxFloor)
    lastTs = t

    if (res === 'breach' || res === 'passed') break
    if (++minutes > MAX_MINUTES) {
      return { ...base, error: 'This span is too long to check minute by minute.' }
    }

    if (live.size) {
      t += 60
    } else {
      // Nothing open: nothing can breach, so jump to whatever happens next.
      const nextEvent = oi < opens.length ? opens[oi].t : end + 60
      if (boundary <= t) boundary = nextDayBoundary(t)
      t = Math.min(nextEvent, boundary)
      if (t > end) break
    }
    if (t >= boundary) boundary = nextDayBoundary(t)
  }

  const st = runtime.status()
  return {
    ...base,
    outcome: st.outcome === 'failed' ? 'failed' : st.outcome === 'passed' ? 'passed' : 'incomplete',
    breach: st.breach,
    endedAt: lastTs,
    finalBalance: balance,
    profit: balance - size,
    targetUsd: st.targetUsd,
    peakProfit: Math.max(0, peakEquity - size),
    worstDrawdown: Math.max(0, size - troughEquity),
    dailyRoomLeft: isFinite(minDailyRoom) ? minDailyRoom : 0,
    maxRoomLeft: isFinite(minMaxRoom) ? minMaxRoom : 0,
    tradingDays: st.tradingDays,
    minTradingDays: stage.minTradingDays,
    tradesUsed: trades.length,
  }
}

/** Every stage of a rule set, so the report shows where a strategy stands overall. */
export async function checkAllStages(req: Omit<CheckRequest, 'stageId'>): Promise<StageVerdict[]> {
  const out: StageVerdict[] = []
  for (const stage of req.rules.stages) {
    out.push(await checkStage({ ...req, stageId: stage.id }))
  }
  return out
}

/**
 * The trades belonging to a saved session. Sessions recorded before db v6 have
 * no sessionId on their trades, so fall back to the account plus the span the
 * session covered — which is what a trade from that session would match anyway.
 */
export async function tradesForSession(
  dbTrades: Trade[],
  sessionId: number | undefined,
  accountId: number,
  from: number,
  to: number,
): Promise<Trade[]> {
  const tagged = sessionId ? dbTrades.filter(t => t.sessionId === sessionId) : []
  if (tagged.length) return tagged
  return dbTrades.filter(t => t.accountId === accountId && t.entryTime >= from && t.entryTime <= to)
}
