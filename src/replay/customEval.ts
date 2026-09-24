// Runtime for user-authored indicators. User code is compiled once via
// `new Function` (strict mode) and cached by content hash — the same
// definition is called on every chart pane, tick, and window without paying
// the compile cost again.
//
// Contract for user code:
//   - Body executes with `bars` and `helpers` in scope
//   - Must return an array of numbers matching bars.length. NaN entries are
//     treated as warmup / gap and skipped when drawing the line.
//   - No async, no I/O — the runtime doesn't await
//
// Safety: user code runs in the renderer with no isolation beyond strict
// mode. This is a personal, local-first app where the user is the only one
// running their own code, so we don't sandbox further. We do catch runtime
// errors and surface them to the settings UI rather than crashing the app.

import type { Bar } from '../lib/types'

export interface CustomHelpers {
  sma: (values: number[], length: number) => number[]
  ema: (values: number[], length: number) => number[]
  stdev: (values: number[], length: number) => number[]
  highest: (values: number[], length: number) => number[]
  lowest: (values: number[], length: number) => number[]
  rma: (values: number[], length: number) => number[]  // Wilder / RMA — used by ATR, RSI
  change: (values: number[]) => number[]
}

type Compiled = (bars: Bar[], helpers: CustomHelpers) => unknown

const cache = new Map<string, Compiled>()

/** Compile once, cache by exact code string. Returns null if the code doesn't parse. */
export function compileCustomIndicator(code: string): { fn: Compiled | null; error: string | null } {
  const cached = cache.get(code)
  if (cached) return { fn: cached, error: null }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('bars', 'helpers', `"use strict";\n${code}`) as Compiled
    cache.set(code, fn)
    return { fn, error: null }
  } catch (e: any) {
    return { fn: null, error: normalizeErr(e) }
  }
}

/**
 * Compile + run against bars. Returns an aligned number array (length ===
 * bars.length) plus any error string. On error the returned array is empty.
 */
export function runCustomIndicator(code: string, bars: Bar[]): { values: number[]; error: string | null } {
  const { fn, error } = compileCustomIndicator(code)
  if (!fn) return { values: [], error }
  try {
    const raw = fn(bars, HELPERS)
    if (!Array.isArray(raw)) {
      return { values: [], error: `Expected array return, got ${typeof raw}` }
    }
    const out: number[] = new Array(bars.length)
    for (let i = 0; i < bars.length; i++) {
      const v = raw[i]
      out[i] = typeof v === 'number' ? v : NaN
    }
    return { values: out, error: null }
  } catch (e: any) {
    return { values: [], error: normalizeErr(e) }
  }
}

function normalizeErr(e: any): string {
  const s = String(e?.message ?? e)
  return s.length > 400 ? s.slice(0, 400) + '…' : s
}

// ─── Helpers exposed to user code ────────────────────────────────────────────

function sma(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 0 || L > n) return out
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += values[i]
    if (i >= L) sum -= values[i - L]
    if (i >= L - 1) out[i] = sum / L
  }
  return out
}

function ema(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 0 || L > n) return out
  const k = 2 / (L + 1)
  let e = NaN
  let seed = 0
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (i < L - 1) { seed += v; continue }
    if (i === L - 1) { seed += v; e = seed / L } else { e = v * k + e * (1 - k) }
    out[i] = e
  }
  return out
}

function rma(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 0 || L > n) return out
  let r = NaN, seed = 0
  const alpha = 1 / L
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (i < L - 1) { seed += v; continue }
    if (i === L - 1) { seed += v; r = seed / L } else { r = alpha * v + (1 - alpha) * r }
    out[i] = r
  }
  return out
}

function stdev(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 1 || L > n) return out
  for (let i = L - 1; i < n; i++) {
    let sum = 0
    for (let j = i - L + 1; j <= i; j++) sum += values[j]
    const mean = sum / L
    let sq = 0
    for (let j = i - L + 1; j <= i; j++) { const d = values[j] - mean; sq += d * d }
    out[i] = Math.sqrt(sq / L)
  }
  return out
}

function highest(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 0 || L > n) return out
  for (let i = L - 1; i < n; i++) {
    let hi = -Infinity
    for (let j = i - L + 1; j <= i; j++) if (values[j] > hi) hi = values[j]
    out[i] = hi
  }
  return out
}

function lowest(values: number[], L: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN)
  if (L <= 0 || L > n) return out
  for (let i = L - 1; i < n; i++) {
    let lo = Infinity
    for (let j = i - L + 1; j <= i; j++) if (values[j] < lo) lo = values[j]
    out[i] = lo
  }
  return out
}

function change(values: number[]): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1]
  return out
}

export const HELPERS: CustomHelpers = { sma, ema, rma, stdev, highest, lowest, change }

// ─── Starter examples users can load from the code editor ────────────────────

export interface CodeExample { name: string; code: string }

export const EXAMPLES: CodeExample[] = [
  {
    name: 'SMA 50 (close)',
    code:
`// Simple moving average of close.
const closes = bars.map(b => b.close);
return helpers.sma(closes, 50);`,
  },
  {
    name: 'ATR 14',
    code:
`// Average True Range — Wilder's RMA of true range.
const trs = bars.map((b, i) => {
  if (i === 0) return b.high - b.low;
  const prev = bars[i - 1].close;
  return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
});
return helpers.rma(trs, 14);`,
  },
  {
    name: 'Donchian upper (20)',
    code:
`// Donchian channel upper band — the highest high of the last 20 bars.
const highs = bars.map(b => b.high);
return helpers.highest(highs, 20);`,
  },
  {
    name: 'HMA 21 (close)',
    code:
`// Hull Moving Average of close.
// HMA = WMA(2 * WMA(src, n/2) - WMA(src, n), sqrt(n))
// We approximate with EMA (WMA isn't in helpers) — good enough for a demo.
const closes = bars.map(b => b.close);
const half = helpers.ema(closes, Math.floor(21 / 2));
const full = helpers.ema(closes, 21);
const raw = half.map((v, i) => 2 * v - full[i]);
return helpers.ema(raw.map(v => isFinite(v) ? v : 0), Math.round(Math.sqrt(21)));`,
  },
  {
    name: 'Custom EMA cross flag',
    code:
`// Emits close when fast EMA > slow EMA, NaN otherwise — draws a line under
// the price only during "long" regimes so you can see when your bias flips.
const closes = bars.map(b => b.close);
const fast = helpers.ema(closes, 21);
const slow = helpers.ema(closes, 50);
return closes.map((c, i) =>
  isFinite(fast[i]) && isFinite(slow[i]) && fast[i] > slow[i] ? c * 0.998 : NaN
);`,
  },
]
