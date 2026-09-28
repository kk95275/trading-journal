// Python-strategy backtest runner. The user's Python `on_bar(ctx)` function
// is called once per bar; ctx bridges into JS so buy/sell/close mutate the
// same in-memory book we track here.
//
// Contract for user code (contract stays in sync with EXAMPLES below):
//
//   # bars: list of dicts up to and including the current bar
//   # ctx.now  -> current bar time (epoch seconds, UTC)
//   # ctx.price -> current bar close
//   # ctx.position -> dict with {direction, entry, lots, sl, tp} or None
//   # ctx.buy(lots, sl=None, tp=None) — open long at ask (bid + spread)
//   # ctx.sell(lots, sl=None, tp=None) — open short at bid
//   # ctx.close() — flatten at current market
//   # ctx.log(msg) — dev-console log
//
//   def on_bar(ctx):
//       ...
//
// Fills, SL/TP checks, and P&L math mirror src/replay/engine.ts so numbers
// line up with what you'd see stepping through the interactive backtester.

import type { Bar, Trade, Direction, ExitReason } from '../lib/types'
import type { StrategyFile } from '../db'
import { pnlUsd, riskUsd } from '../lib/gold'
import { specFor } from '../lib/symbols'
import { loadPyodideRuntime, type PyodideRuntime } from './pyodide'
import { TA_MODULE_SOURCE } from './ta'

export interface BacktestConfig {
  symbol: string
  bars: Bar[]              // 1-minute bars, sorted ascending, all in the run window
  spread: number
  commissionPerLot: number // round-turn, per lot
  startingBalance: number
}

/** Where user files land in Pyodide's virtual FS. */
const STRATEGY_DIR = '/tmp/strategy'
/** Bundled helpers — a separate directory so it survives strategy-file wipes. */
const BUILTIN_LIB_DIR = '/tj_lib'

export interface BacktestPosition {
  direction: Direction
  entryPrice: number
  entryTime: number
  lots: number
  sl?: number
  tp?: number
}

export interface BacktestTrade extends Trade {
  // Reuse the Trade shape (accountId=0 for backtest-only trades).
}

export interface EquityPoint { time: number; equity: number }

export interface BacktestResult {
  trades: BacktestTrade[]
  equity: EquityPoint[]
  finalBalance: number
  logs: string[]
  error: string | null
  /** How many bars raised a Python exception. 0 on a clean run. */
  errorCount: number
  /** Bars actually simulated — less than bars.length if the run aborted. */
  barsProcessed: number
  runtimeSeconds: number
}

/** Hourly / DOW breakdowns useful for the AI "best time of day" prompt. */
export interface HourStat { hour: number; n: number; wins: number; pnl: number }
export interface DowStat { day: string; n: number; wins: number; pnl: number }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function hourlyBreakdown(trades: BacktestTrade[]): HourStat[] {
  const buckets: HourStat[] = Array.from({ length: 24 }, (_, h) => ({ hour: h, n: 0, wins: 0, pnl: 0 }))
  for (const t of trades) {
    const h = new Date(t.entryTime * 1000).getUTCHours()
    buckets[h].n++
    if (t.pnl > 0) buckets[h].wins++
    buckets[h].pnl += t.pnl
  }
  return buckets
}
export function dowBreakdown(trades: BacktestTrade[]): DowStat[] {
  const buckets: DowStat[] = DOW.map(day => ({ day, n: 0, wins: 0, pnl: 0 }))
  for (const t of trades) {
    const d = new Date(t.entryTime * 1000).getUTCDay()
    buckets[d].n++
    if (t.pnl > 0) buckets[d].wins++
    buckets[d].pnl += t.pnl
  }
  return buckets
}

const CONTRACT_HEADER =
`# Backtest runner injects these globals before your code runs:
#   on_bar(ctx) — implement this
# ctx exposes:
#   now, price, ask, bid, spread, balance, position
#   open, high, low, close, volume        (current bar values)
#   opens, highs, lows, closes, volumes   (arrays: [-1] = now, [-n] = n bars ago)
#   bars                                  (list of dicts, one per bar; bars[-1] = now)
#   recent_closes(n), recent_highs(n), recent_lows(n), recent_opens(n),
#   recent_volumes(n), recent_bars(n)     (last n values as a real list)
# Python slicing works too: list(ctx.closes)[-20:] returns the last 20 closes.
#
# Higher timeframes:
#   htf = ctx.tf('1h')                   # or '5m', '4h', '1d', or seconds
#   htf.close                            # current forming 1h close
#   htf.closes[-2]                       # last COMPLETED 1h close
#   sma(htf.closes, 200)                 # 200-period SMA on 1h
# The last element of every htf array is the CURRENT (still forming) bar,
# so [-2] is the most recent completed bar. Aggregation is incremental.
#   buy(lots, sl=None, tp=None), sell(...), exit()/close_position(), set_sl(px), set_tp(px), log(msg)
#
# Also available at module level (no imports needed):
#   sma, ema, rma, wma, stdev, highest, lowest, change,
#   rsi, macd, bbands, atr, vwap, roc, momentum,
#   cross_up, cross_down, is_finite, nan
# Or use them via the 'ta' module: ta.sma(closes, 20), ta.rsi(closes)
`

/** Runs once on the first backtest of an app session. Idempotent. */
let builtinLibInstalled = false
function installBuiltinLib(py: PyodideRuntime): void {
  if (builtinLibInstalled) return
  const FS = (py as unknown as { FS: any }).FS
  try { FS.mkdirTree(BUILTIN_LIB_DIR) } catch { /* exists */ }
  FS.writeFile(`${BUILTIN_LIB_DIR}/ta.py`, TA_MODULE_SOURCE, { encoding: 'utf8' })
  py.runPython(
`import sys
if "${BUILTIN_LIB_DIR}" not in sys.path:
    sys.path.insert(0, "${BUILTIN_LIB_DIR}")
`,
  )
  builtinLibInstalled = true
}

export interface RunProgress {
  processed: number
  total: number
  message: string
}

export async function runBacktest(
  cfg: BacktestConfig,
  files: StrategyFile[],
  mainFile: string,
  onProgress?: (p: RunProgress) => void,
): Promise<BacktestResult> {
  const t0 = performance.now()
  onProgress?.({ processed: 0, total: cfg.bars.length, message: 'Loading Python runtime…' })

  const py = await loadPyodideRuntime()

  // Bundled helper library — written to a separate FS dir that survives
  // strategy-file wipes. Idempotent, so cheap to call every run.
  installBuiltinLib(py)

  // Mount every user file to the pyodide FS so `import mylib` inside main.py
  // finds sibling modules. Then flatten ta helpers into the module globals
  // and execute the main file so its top-level `on_bar` lands in the runtime's
  // globals too.
  try {
    mountStrategyFiles(py, files)
    const main = files.find(f => f.name === mainFile) ?? files[0]
    if (!main) throw new Error('No files in strategy')
    py.runPython(
`import ta
from ta import (
    sma, ema, rma, wma, stdev, highest, lowest, change,
    rsi, macd, bbands, atr, vwap, roc, momentum,
    cross_up, cross_down, is_finite,
)
from math import nan
`,
    )
    py.runPython(`${CONTRACT_HEADER}\n${main.content}`)
  } catch (e: any) {
    return baseError(`Compile error: ${e?.message ?? e}`, t0, cfg)
  }

  const on_bar = py.globals.get('on_bar')
  if (!on_bar || typeof on_bar.callKwargs !== 'function' && typeof on_bar !== 'function') {
    return baseError(`Your ${mainFile} did not define an on_bar(ctx) function.`, t0, cfg)
  }

  const state = new BookState(cfg)
  const logs: string[] = []
  const ctx = state.buildCtx(logs)
  py.globals.set('__ctx', ctx)

  // Iterate bars. Progress messages are throttled to keep the UI responsive
  // without paying a React-render cost per bar (typical run is 10k-50k bars).
  const REPORT_EVERY = Math.max(1, Math.floor(cfg.bars.length / 40))
  // A throwing on_bar used to kill the whole run on the first bad bar, which
  // made a broken strategy look identical to a strategy that simply never
  // traded. Now we record the first error, keep going, and only abort once
  // it's clear every bar is failing.
  const MAX_ERRORS = 50
  let error: string | null = null
  let errorCount = 0
  let barsProcessed = 0

  for (let i = 0; i < cfg.bars.length; i++) {
    state.tick(i)
    barsProcessed = i + 1
    try {
      // Call on_bar with the shared ctx. Pyodide bridges JS objects transparently.
      on_bar(ctx)
    } catch (e: any) {
      errorCount++
      if (!error) {
        const at = new Date(cfg.bars[i].time * 1000).toISOString()
        error = `Python error at bar ${i + 1} (${at}):\n${e?.message ?? e}`
      }
      if (errorCount >= MAX_ERRORS) {
        error += `\n\nAborted after ${errorCount} failing bars — the error above is raised on essentially every bar. Fix it and re-run.`
        break
      }
    }
    if (i % REPORT_EVERY === 0) {
      onProgress?.({
        processed: i + 1,
        total: cfg.bars.length,
        message: `Simulating bar ${i + 1} / ${cfg.bars.length}`,
      })
      // Yield to the event loop so the UI can paint mid-run.
      await new Promise(r => setTimeout(r, 0))
    }
  }
  // Flush any remaining open position at the last bar so equity is consistent.
  state.flushOpenAtEnd()

  // Always leave a trail in the logs so "did it actually do anything?" is
  // answerable without guessing from the stat cards.
  logs.push(
    `[runner] done — ${barsProcessed.toLocaleString()} bars simulated, ` +
    `${state.trades.length} trade(s) recorded, final balance ${state.balance.toFixed(2)}` +
    (errorCount ? `, ${errorCount} bar(s) raised an error` : ''),
  )

  return {
    trades: state.trades,
    equity: state.equity,
    finalBalance: +state.balance.toFixed(2),
    logs,
    error,
    errorCount,
    barsProcessed,
    runtimeSeconds: (performance.now() - t0) / 1000,
  }
}

/**
 * Write every user file to Pyodide's virtual FS at STRATEGY_DIR, add that dir
 * to sys.path, and purge any previously-imported user modules so a re-run picks
 * up code edits.
 */
function mountStrategyFiles(py: PyodideRuntime, files: StrategyFile[]): void {
  // FS access is exposed on the runtime as a top-level `FS` property. The
  // Pyodide types don't advertise it, but it's the documented public API.
  const FS = (py as unknown as { FS: any }).FS
  try { FS.mkdirTree(STRATEGY_DIR) } catch { /* already exists */ }
  // Wipe previous files so a renamed/deleted module doesn't linger.
  try {
    for (const entry of FS.readdir(STRATEGY_DIR) as string[]) {
      if (entry === '.' || entry === '..') continue
      try { FS.unlink(`${STRATEGY_DIR}/${entry}`) } catch { /* skip */ }
    }
  } catch { /* directory didn't exist */ }

  const moduleNames: string[] = []
  for (const f of files) {
    // Guard against filename shenanigans — no slashes, must end in .py, must
    // be a plain identifier stem. Enforced by the UI too but check in depth.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.py$/.test(f.name)) {
      throw new Error(`Invalid file name "${f.name}" — use letters/digits/underscore + .py`)
    }
    FS.writeFile(`${STRATEGY_DIR}/${f.name}`, f.content, { encoding: 'utf8' })
    moduleNames.push(f.name.slice(0, -3))
  }

  // Add STRATEGY_DIR to sys.path (once) and drop any stale module entries so
  // `import` re-reads from disk. Escape the module names for the Python literal.
  const stalePyList = '[' + moduleNames.map(n => `"${n}"`).join(',') + ']'
  py.runPython(
`import sys
_p = "${STRATEGY_DIR}"
if _p not in sys.path:
    sys.path.insert(0, _p)
for _m in ${stalePyList}:
    sys.modules.pop(_m, None)
`,
  )
}

function baseError(msg: string, t0: number, cfg: BacktestConfig): BacktestResult {
  return {
    trades: [], equity: [], finalBalance: cfg.startingBalance,
    logs: [], error: msg,
    errorCount: 1, barsProcessed: 0,
    runtimeSeconds: (performance.now() - t0) / 1000,
  }
}

// ─── Book state (positions, trades, equity) ─────────────────────────────────

class BookState {
  balance: number
  trades: BacktestTrade[] = []
  equity: EquityPoint[] = []
  position: BacktestPosition | null = null

  private curIdx = 0
  private cfg: BacktestConfig
  // One aggregator per requested higher timeframe. Lazily created — only
  // pays the cost for timeframes the strategy actually touches. The wrapper
  // object we return to Python is cached too, so ctx.tf('1h') returns the
  // same object every call.
  private tfViews = new Map<number, { view: HigherTfView; ctx: unknown }>()

  constructor(cfg: BacktestConfig) {
    this.cfg = cfg
    this.balance = cfg.startingBalance
  }

  /** Get (or lazily build) the wrapper for `sec`, aggregated up to curIdx. */
  getTfView(sec: number): unknown {
    let entry = this.tfViews.get(sec)
    if (!entry) {
      const view = new HigherTfView(sec, this.cfg.bars)
      entry = { view, ctx: buildTfCtx(view) }
      this.tfViews.set(sec, entry)
    }
    entry.view.updateTo(this.curIdx)
    return entry.ctx
  }

  private get curBar(): Bar { return this.cfg.bars[this.curIdx] }
  private get bid(): number { return this.curBar.close }
  private get ask(): number { return this.curBar.close + this.cfg.spread }

  /** Called once per bar before user code. Fills SL/TP intra-bar. */
  tick(i: number) {
    this.curIdx = i
    if (this.position) {
      const bar = this.curBar
      const p = this.position
      const s = this.cfg.spread
      if (p.direction === 'long') {
        if (p.sl !== undefined && bar.low <= p.sl) { this.fillExit(p.sl, 'sl'); return }
        if (p.tp !== undefined && bar.high >= p.tp) { this.fillExit(p.tp, 'tp'); return }
      } else {
        if (p.sl !== undefined && bar.high + s >= p.sl) { this.fillExit(p.sl, 'sl'); return }
        if (p.tp !== undefined && bar.low + s <= p.tp) { this.fillExit(p.tp, 'tp'); return }
      }
    }
    // Record equity after any intra-bar exits.
    const openPnl = this.position
      ? pnlUsd(this.position.direction, this.position.entryPrice,
              this.position.direction === 'long' ? this.bid : this.ask,
              this.position.lots, this.cfg.symbol) - this.cfg.commissionPerLot * this.position.lots
      : 0
    this.equity.push({ time: this.curBar.time, equity: +(this.balance + openPnl).toFixed(2) })
  }

  flushOpenAtEnd() {
    if (!this.position) return
    const exit = this.position.direction === 'long' ? this.bid : this.ask
    this.fillExit(exit, 'other')
  }

  private fillExit(exitPrice: number, reason: ExitReason) {
    const p = this.position!
    const symbol = this.cfg.symbol
    const fees = this.cfg.commissionPerLot * p.lots
    const gross = pnlUsd(p.direction, p.entryPrice, exitPrice, p.lots, symbol)
    const pnl = +(gross - fees).toFixed(2)
    const risk = p.sl !== undefined ? riskUsd(p.direction, p.entryPrice, p.sl, p.lots, symbol) : undefined
    const px = specFor(symbol).decimals + 1
    this.trades.push({
      accountId: 0,
      symbol,
      direction: p.direction,
      lots: p.lots,
      entryTime: p.entryTime,
      exitTime: this.curBar.time,
      entryPrice: +p.entryPrice.toFixed(px),
      exitPrice: +exitPrice.toFixed(px),
      sl: p.sl,
      tp: p.tp,
      pnl,
      fees,
      riskAmount: risk,
      rMultiple: risk && risk > 0 ? +(pnl / risk).toFixed(3) : undefined,
      exitReason: reason,
      confirmations: [],
      mistakes: [],
      notes: '',
      tags: [],
    })
    this.balance = +(this.balance + pnl).toFixed(2)
    this.position = null
  }

  /** Build the JS ctx that Python calls into. Fresh each backtest. */
  buildCtx(logs: string[]) {
    const self = this
    return {
      // Fields Python reads.
      get now() { return self.curBar.time },
      get price() { return self.bid },
      get bid() { return self.bid },
      get ask() { return self.ask },
      get spread() { return self.cfg.spread },
      get balance() { return self.balance },
      // Current-bar OHLC shortcuts — the most common thing you need.
      get open()   { return self.curBar.open },
      get high()   { return self.curBar.high },
      get low()    { return self.curBar.low },
      get close()  { return self.curBar.close },
      get volume() { return self.curBar.volume },
      // OHLC as arrays up to (and including) the current bar. Backed by a
      // Proxy so we don't materialize the full array every tick.
      opens:   buildFieldProxy(self.cfg.bars, 'open',   () => self.curIdx),
      highs:   buildFieldProxy(self.cfg.bars, 'high',   () => self.curIdx),
      lows:    buildFieldProxy(self.cfg.bars, 'low',    () => self.curIdx),
      closes:  buildFieldProxy(self.cfg.bars, 'close',  () => self.curIdx),
      volumes: buildFieldProxy(self.cfg.bars, 'volume', () => self.curIdx),
      // Grab the last N values as a plain list — one line, no slice math.
      // Python's slicing on the proxied arrays (list(ctx.closes)[-20:]) also
      // works thanks to the [Symbol.iterator] implementation below.
      recent_bars(n: number) { return tailBars(self.cfg.bars, self.curIdx, n) },
      recent_opens(n: number)   { return tailField(self.cfg.bars, self.curIdx, n, 'open') },
      recent_highs(n: number)   { return tailField(self.cfg.bars, self.curIdx, n, 'high') },
      recent_lows(n: number)    { return tailField(self.cfg.bars, self.curIdx, n, 'low') },
      recent_closes(n: number)  { return tailField(self.cfg.bars, self.curIdx, n, 'close') },
      recent_volumes(n: number) { return tailField(self.cfg.bars, self.curIdx, n, 'volume') },
      // Higher-timeframe view. ctx.tf('1h') / ctx.tf('4h') / ctx.tf(300)
      // returns a mini-ctx with the same OHLC surface (open/high/low/close,
      // opens/highs/lows/closes/volumes, bars, recent_*) aggregated from the
      // underlying 1m bars. The last element of every array is the CURRENT
      // (forming) higher-tf bar, so `htf.closes[-2]` is the last completed one.
      tf(spec: string | number) { return self.getTfView(parseTfSpec(spec)) },
      get position() {
        if (!self.position) return null
        return {
          direction: self.position.direction,
          entry: self.position.entryPrice,
          lots: self.position.lots,
          sl: self.position.sl ?? null,
          tp: self.position.tp ?? null,
          entry_time: self.position.entryTime,
        }
      },
      // Ordering.
      // Ordering. Pyodide passes Python kwargs to JS by bundling them into a
      // final positional object — `ctx.buy(0.05, sl=X, tp=Y)` arrives here as
      // `buy(0.05, {sl:X, tp:Y})`. Detect the object case and unpack so both
      // calling styles work.
      buy(lots: number, sl?: any, tp?: any) {
        if (typeof sl === 'object' && sl !== null) { tp = sl.tp; sl = sl.sl }
        if (self.position) return false
        if (!(typeof lots === 'number' && lots > 0)) return false
        const slN = typeof sl === 'number' && isFinite(sl) ? sl : undefined
        const tpN = typeof tp === 'number' && isFinite(tp) ? tp : undefined
        self.position = {
          direction: 'long',
          entryPrice: self.ask,
          entryTime: self.curBar.time,
          lots,
          sl: slN,
          tp: tpN,
        }
        return true
      },
      sell(lots: number, sl?: any, tp?: any) {
        if (typeof sl === 'object' && sl !== null) { tp = sl.tp; sl = sl.sl }
        if (self.position) return false
        if (!(typeof lots === 'number' && lots > 0)) return false
        const slN = typeof sl === 'number' && isFinite(sl) ? sl : undefined
        const tpN = typeof tp === 'number' && isFinite(tp) ? tp : undefined
        self.position = {
          direction: 'short',
          entryPrice: self.bid,
          entryTime: self.curBar.time,
          lots,
          sl: slN,
          tp: tpN,
        }
        return true
      },
      // Position close. ctx.close is now the current bar's close price, so the
      // action lives under ctx.exit() / ctx.close_position(). Both are aliases.
      exit() {
        if (!self.position) return false
        const exit = self.position.direction === 'long' ? self.bid : self.ask
        self.fillExit(exit, 'manual')
        return true
      },
      close_position() {
        if (!self.position) return false
        const exit = self.position.direction === 'long' ? self.bid : self.ask
        self.fillExit(exit, 'manual')
        return true
      },
      set_sl(sl: any) {
        if (typeof sl === 'object' && sl !== null && 'sl' in sl) sl = sl.sl
        if (self.position) self.position.sl = typeof sl === 'number' && isFinite(sl) ? sl : undefined
      },
      set_tp(tp: any) {
        if (typeof tp === 'object' && tp !== null && 'tp' in tp) tp = tp.tp
        if (self.position) self.position.tp = typeof tp === 'number' && isFinite(tp) ? tp : undefined
      },
      log(msg: unknown) {
        const s = typeof msg === 'string' ? msg : JSON.stringify(msg)
        if (logs.length < 500) logs.push(`[${new Date(self.curBar.time * 1000).toISOString()}] ${s}`)
      },
      // Access to bars up to (and including) current — a Python list of dicts.
      // We build this lazily to avoid materializing the full array every tick.
      bars: buildBarsProxy(self.cfg.bars, () => self.curIdx),
    }
  }
}

/**
 * Python-facing single-field accessor. `ctx.closes[-1]` returns the current
 * bar's close; `list(ctx.closes)` returns the full history so Python slicing
 * works (`list(ctx.closes)[-20:]`). Length caps at curIdx + 1 so nothing
 * — indexing, iteration, or slicing — can peek at future bars.
 */
function buildFieldProxy<K extends keyof Bar>(bars: Bar[], key: K, getIdx: () => number): number[] {
  return new Proxy(bars, {
    get(target, prop) {
      const idx = getIdx()
      if (prop === 'length') return idx + 1
      if (prop === Symbol.iterator) {
        // Makes `for x in ctx.closes` and `list(ctx.closes)` work in Python.
        return function* () {
          for (let i = 0; i <= idx; i++) yield target[i][key] as number
        }
      }
      if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
        let i = Number(prop)
        if (i < 0) i = idx + 1 + i
        if (i < 0 || i > idx) return undefined
        return target[i][key] as number
      }
      return (target as any)[prop]
    },
  }) as unknown as number[]
}

/** Python-facing bars accessor. `ctx.bars[-1]` returns current bar dict;
 * `list(ctx.bars)` returns a real list of dicts. */
function buildBarsProxy(bars: Bar[], getIdx: () => number) {
  const barDict = (b: Bar) => ({
    time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  })
  return new Proxy(bars, {
    get(target, prop) {
      const idx = getIdx()
      if (prop === 'length') return idx + 1
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i <= idx; i++) yield barDict(target[i])
        }
      }
      if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
        let i = Number(prop)
        if (i < 0) i = idx + 1 + i
        if (i < 0 || i > idx) return undefined
        return barDict(target[i])
      }
      return (target as any)[prop]
    },
  }) as unknown as Bar[]
}

// ─── Higher-timeframe aggregator ────────────────────────────────────────────

/**
 * Aggregates 1-minute bars into a higher timeframe incrementally as the
 * replay advances. bars[bars.length - 1] is ALWAYS the "current" (forming)
 * higher-tf bar — updates in place as more 1m data arrives inside the bucket.
 * When we cross a bucket boundary the previous bar is finalized (never
 * mutated again) and a new one is pushed.
 */
class HigherTfView {
  bars: Bar[] = []
  private lastBaseIdx = -1
  constructor(private tfSec: number, private baseBars: Bar[]) {}

  updateTo(curBaseIdx: number): void {
    if (curBaseIdx <= this.lastBaseIdx) return
    for (let i = this.lastBaseIdx + 1; i <= curBaseIdx; i++) {
      const b = this.baseBars[i]
      const bucketStart = Math.floor(b.time / this.tfSec) * this.tfSec
      const last = this.bars.length ? this.bars[this.bars.length - 1] : null
      if (last && last.time === bucketStart) {
        if (b.high > last.high) last.high = b.high
        if (b.low  < last.low)  last.low  = b.low
        last.close = b.close
        last.volume += b.volume
      } else {
        this.bars.push({
          time: bucketStart,
          open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        })
      }
    }
    this.lastBaseIdx = curBaseIdx
  }
}

/** Same OHLC surface ctx exposes for 1m, but backed by an aggregated view. */
function buildTfCtx(view: HigherTfView) {
  const curIdx = () => view.bars.length - 1
  const curBar = () => view.bars[curIdx()]
  return {
    get time()   { return curBar()?.time   ?? 0 },
    get open()   { return curBar()?.open   ?? 0 },
    get high()   { return curBar()?.high   ?? 0 },
    get low()    { return curBar()?.low    ?? 0 },
    get close()  { return curBar()?.close  ?? 0 },
    get volume() { return curBar()?.volume ?? 0 },
    opens:   buildFieldProxy(view.bars, 'open',   curIdx),
    highs:   buildFieldProxy(view.bars, 'high',   curIdx),
    lows:    buildFieldProxy(view.bars, 'low',    curIdx),
    closes:  buildFieldProxy(view.bars, 'close',  curIdx),
    volumes: buildFieldProxy(view.bars, 'volume', curIdx),
    bars:    buildBarsProxy(view.bars, curIdx),
    recent_bars(n: number)    { return tailBars(view.bars, curIdx(), n) },
    recent_opens(n: number)   { return tailField(view.bars, curIdx(), n, 'open') },
    recent_highs(n: number)   { return tailField(view.bars, curIdx(), n, 'high') },
    recent_lows(n: number)    { return tailField(view.bars, curIdx(), n, 'low') },
    recent_closes(n: number)  { return tailField(view.bars, curIdx(), n, 'close') },
    recent_volumes(n: number) { return tailField(view.bars, curIdx(), n, 'volume') },
  }
}

/** '1m' / '5m' / '15m' / '30m' / '1h' / '4h' / '1d' / '1w' — or seconds as a number. */
function parseTfSpec(spec: string | number): number {
  if (typeof spec === 'number') {
    const n = Math.floor(spec)
    if (n < 60) throw new Error(`Timeframe too short: ${spec}s (min 60s)`)
    return n
  }
  const m = String(spec).trim().toLowerCase().match(/^(\d+)\s*(m|h|d|w)$/)
  if (!m) throw new Error(`Bad timeframe "${spec}" — use '5m', '15m', '1h', '4h', '1d', or seconds`)
  const n = Number(m[1])
  const mult = m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : m[2] === 'd' ? 86400 : 604800
  const sec = n * mult
  if (sec < 60) throw new Error(`Timeframe too short: ${spec}`)
  return sec
}

/** Last-N helpers. Return real arrays so Python slicing on the result works too. */
function tailField(bars: Bar[], curIdx: number, n: number, key: keyof Bar): number[] {
  const out: number[] = []
  const from = Math.max(0, curIdx - Math.max(0, Math.floor(n)) + 1)
  for (let i = from; i <= curIdx; i++) out.push(bars[i][key] as number)
  return out
}
function tailBars(bars: Bar[], curIdx: number, n: number) {
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
  const from = Math.max(0, curIdx - Math.max(0, Math.floor(n)) + 1)
  for (let i = from; i <= curIdx; i++) {
    const b = bars[i]
    out.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })
  }
  return out
}
