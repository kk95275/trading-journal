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
#   open, high, low, close, volume        (current bar)
#   opens, highs, lows, closes, volumes   (arrays up to current bar)
#   bars                                  (list of dicts, one per bar)
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
  let error: string | null = null

  for (let i = 0; i < cfg.bars.length; i++) {
    state.tick(i)
    try {
      // Call on_bar with the shared ctx. Pyodide bridges JS objects transparently.
      on_bar(ctx)
    } catch (e: any) {
      error = `Runtime error at bar ${i} (${new Date(cfg.bars[i].time * 1000).toISOString()}): ${e?.message ?? e}`
      break
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

  return {
    trades: state.trades,
    equity: state.equity,
    finalBalance: +state.balance.toFixed(2),
    logs,
    error,
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

  constructor(cfg: BacktestConfig) {
    this.cfg = cfg
    this.balance = cfg.startingBalance
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
      buy(lots: number, sl: number | null = null, tp: number | null = null) {
        if (self.position) return false
        if (!(lots > 0)) return false
        self.position = {
          direction: 'long',
          entryPrice: self.ask,
          entryTime: self.curBar.time,
          lots,
          sl: sl ?? undefined,
          tp: tp ?? undefined,
        }
        return true
      },
      sell(lots: number, sl: number | null = null, tp: number | null = null) {
        if (self.position) return false
        if (!(lots > 0)) return false
        self.position = {
          direction: 'short',
          entryPrice: self.bid,
          entryTime: self.curBar.time,
          lots,
          sl: sl ?? undefined,
          tp: tp ?? undefined,
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
      set_sl(sl: number | null) { if (self.position) self.position.sl = sl ?? undefined },
      set_tp(tp: number | null) { if (self.position) self.position.tp = tp ?? undefined },
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
 * bar's close as a number. Length caps at curIdx + 1 so `sma(ctx.closes, 20)`
 * never peeks at future bars by accident.
 */
function buildFieldProxy<K extends keyof Bar>(bars: Bar[], key: K, getIdx: () => number): number[] {
  return new Proxy(bars, {
    get(target, prop) {
      const idx = getIdx()
      if (prop === 'length') return idx + 1
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

/** Python-facing bars accessor. `ctx.bars[-1]` returns current bar dict. */
function buildBarsProxy(bars: Bar[], getIdx: () => number) {
  // Pyodide preserves numeric indexing on plain JS arrays, but we want to
  // *cap* the view at the current bar so users can't peek the future by
  // accident. Return a wrapper with .length + numeric indexing that Pyodide
  // handles fine via its default JS-array proxying.
  return new Proxy(bars, {
    get(target, prop) {
      const idx = getIdx()
      if (prop === 'length') return idx + 1
      if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
        let i = Number(prop)
        if (i < 0) i = idx + 1 + i
        if (i < 0 || i > idx) return undefined
        const b = target[i]
        // Pyodide serializes plain objects to dict; keep fields flat.
        return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
      }
      return (target as any)[prop]
    },
  }) as unknown as Bar[]
}
