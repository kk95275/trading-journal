// Built-in chart indicators. Overlays (MA/EMA, Bollinger, VWAP) render on the main
// chart via OverlayManager; oscillators (RSI, MACD) render in synced panes below.
// Full recompute + setData on rebuilds/config changes, O(window) incremental
// updates while the replay plays (EMA-family keeps prev/last state so a forming
// candle can mutate without drift).
import { LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import type { Bar } from '../lib/types'

export type IndicatorKind = 'ma' | 'bb' | 'vwap' | 'rsi' | 'macd'

export interface ActiveIndicator {
  id: string
  kind: IndicatorKind
  color: string
  maType?: 'sma' | 'ema' // ma
  length?: number        // ma, bb, rsi
  mult?: number          // bb
  fast?: number          // macd
  slow?: number          // macd
  signal?: number        // macd
}

export interface IndicatorsConfig {
  showVolume: boolean
  active: ActiveIndicator[]
}

export const INDICATOR_COLORS = ['#3987e5', '#eda100', '#e8e6df', '#0ca30c', '#d03b3b', '#9085e9', '#e87ba4', '#eb6834']

export function defaultIndicatorsConfig(): IndicatorsConfig {
  return { showVolume: true, active: [] }
}

export const isOscillator = (k: IndicatorKind) => k === 'rsi' || k === 'macd'

export function indicatorLabel(a: ActiveIndicator): string {
  switch (a.kind) {
    case 'ma': return `${(a.maType ?? 'ema').toUpperCase()} ${a.length ?? 20}`
    case 'bb': return `Bollinger (${a.length ?? 20}, ${a.mult ?? 2}σ)`
    case 'vwap': return 'VWAP (daily)'
    case 'rsi': return `RSI ${a.length ?? 14}`
    case 'macd': return `MACD ${a.fast ?? 12}/${a.slow ?? 26}/${a.signal ?? 9}`
  }
}

/** Migrate the pre-tab config shape ({mas, bb, vwap}) to the active-list shape. */
export function migrateIndicatorsConfig(raw: unknown): IndicatorsConfig {
  const r = raw as any
  if (r && Array.isArray(r.active)) return { showVolume: r.showVolume !== false, active: r.active }
  const active: ActiveIndicator[] = []
  if (r && Array.isArray(r.mas)) {
    for (const m of r.mas) {
      if (m?.enabled) active.push({ id: m.id ?? `ma${active.length}`, kind: 'ma', maType: m.type, length: m.length, color: m.color })
    }
    if (r.bb?.enabled) active.push({ id: 'bb1', kind: 'bb', length: r.bb.length, mult: r.bb.mult, color: r.bb.color })
    if (r.vwap?.enabled) active.push({ id: 'vwap1', kind: 'vwap', color: r.vwap.color })
    return { showVolume: r.showVolume !== false, active }
  }
  return defaultIndicatorsConfig()
}

type LinePoint = { time: UTCTimestamp; value: number }
type MaybePoint = LinePoint | { time: UTCTimestamp } // whitespace during warmup keeps pane logical ranges aligned

/* ---------------- overlay math ---------------- */

function smaSeries(bars: Bar[], L: number): LinePoint[] {
  const out: LinePoint[] = []
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close
    if (i >= L) sum -= bars[i - L].close
    if (i >= L - 1) out.push({ time: bars[i].time as UTCTimestamp, value: sum / L })
  }
  return out
}

function emaSeries(bars: Bar[], L: number): { data: LinePoint[]; prevEma: number; lastEma: number } {
  const k = 2 / (L + 1)
  const out: LinePoint[] = []
  let ema = NaN, prev = NaN, seed = 0
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].close
    if (i < L - 1) { seed += c; continue }
    if (i === L - 1) { seed += c; ema = seed / L } else { prev = ema; ema = c * k + ema * (1 - k) }
    out.push({ time: bars[i].time as UTCTimestamp, value: ema })
  }
  return { data: out, prevEma: prev, lastEma: ema }
}

function bbWindow(bars: Bar[], i: number, L: number): { mean: number; sd: number } {
  let sum = 0
  for (let j = i - L + 1; j <= i; j++) sum += bars[j].close
  const mean = sum / L
  let v = 0
  for (let j = i - L + 1; j <= i; j++) { const d = bars[j].close - mean; v += d * d }
  return { mean, sd: Math.sqrt(v / L) }
}

const dayOf = (ts: number) => Math.floor(ts / 86400)
const typical = (b: Bar) => (b.high + b.low + b.close) / 3

function vwapSeries(bars: Bar[]): LinePoint[] {
  const out: LinePoint[] = []
  let day = -1, pv = 0, vv = 0
  for (const b of bars) {
    const d = dayOf(b.time)
    if (d !== day) { day = d; pv = 0; vv = 0 }
    const vol = b.volume > 0 ? b.volume : 1
    pv += typical(b) * vol
    vv += vol
    out.push({ time: b.time as UTCTimestamp, value: pv / vv })
  }
  return out
}

function vwapAt(bars: Bar[], i: number): number {
  const day = dayOf(bars[i].time)
  let pv = 0, vv = 0
  for (let j = i; j >= 0 && dayOf(bars[j].time) === day; j--) {
    const vol = bars[j].volume > 0 ? bars[j].volume : 1
    pv += typical(bars[j]) * vol
    vv += vol
  }
  return pv / vv
}

/* ---------------- overlay manager (main chart) ---------------- */

interface MaState { def: ActiveIndicator; s: ISeriesApi<'Line'>; lastIdx: number; prevEma: number; lastEma: number }
interface BbState { def: ActiveIndicator; up: ISeriesApi<'Line'>; mid: ISeriesApi<'Line'>; lo: ISeriesApi<'Line'> }

export class OverlayManager {
  private chart: IChartApi
  private all: ISeriesApi<'Line'>[] = []
  private mas: MaState[] = []
  private bbs: BbState[] = []
  private vwaps: ISeriesApi<'Line'>[] = []

  constructor(chart: IChartApi) {
    this.chart = chart
  }

  private addLine(color: string, style: LineStyle): ISeriesApi<'Line'> {
    const s = this.chart.addLineSeries({
      color, lineWidth: 1, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    })
    this.all.push(s)
    return s
  }

  clear() {
    for (const s of this.all) {
      try { this.chart.removeSeries(s) } catch { /* chart may be disposed */ }
    }
    this.all = []
    this.mas = []
    this.bbs = []
    this.vwaps = []
  }

  sync(cfg: IndicatorsConfig, bars: Bar[]) {
    this.clear()
    for (const def of cfg.active) {
      if (def.kind === 'ma') {
        const L = def.length ?? 20
        if (!(L > 0)) continue
        const s = this.addLine(def.color, LineStyle.Solid)
        const st: MaState = { def, s, lastIdx: bars.length - 1, prevEma: NaN, lastEma: NaN }
        if ((def.maType ?? 'ema') === 'sma') {
          s.setData(smaSeries(bars, L))
        } else {
          const r = emaSeries(bars, L)
          s.setData(r.data)
          st.prevEma = r.prevEma
          st.lastEma = r.lastEma
        }
        this.mas.push(st)
      } else if (def.kind === 'bb') {
        const L = def.length ?? 20, mult = def.mult ?? 2
        if (!(L > 1)) continue
        const up: LinePoint[] = [], mid: LinePoint[] = [], lo: LinePoint[] = []
        for (let i = L - 1; i < bars.length; i++) {
          const { mean, sd } = bbWindow(bars, i, L)
          const t = bars[i].time as UTCTimestamp
          mid.push({ time: t, value: mean })
          up.push({ time: t, value: mean + mult * sd })
          lo.push({ time: t, value: mean - mult * sd })
        }
        const sUp = this.addLine(def.color, LineStyle.Solid)
        const sMid = this.addLine(def.color, LineStyle.Dotted)
        const sLo = this.addLine(def.color, LineStyle.Solid)
        sUp.setData(up); sMid.setData(mid); sLo.setData(lo)
        this.bbs.push({ def, up: sUp, mid: sMid, lo: sLo })
      } else if (def.kind === 'vwap') {
        const s = this.addLine(def.color, LineStyle.Solid)
        s.setData(vwapSeries(bars))
        this.vwaps.push(s)
      }
    }
  }

  /** Refresh only the newest bar's values (called on every replay tick). */
  updateLast(bars: Bar[]) {
    const i = bars.length - 1
    if (i < 0) return
    const t = bars[i].time as UTCTimestamp
    for (const m of this.mas) {
      const L = m.def.length ?? 20
      if (i < L - 1) continue
      if ((m.def.maType ?? 'ema') === 'sma') {
        let sum = 0
        for (let j = i - L + 1; j <= i; j++) sum += bars[j].close
        m.s.update({ time: t, value: sum / L })
      } else {
        const k = 2 / (L + 1)
        if (i === m.lastIdx && !isNaN(m.prevEma)) {
          m.lastEma = bars[i].close * k + m.prevEma * (1 - k)
          m.s.update({ time: t, value: m.lastEma })
        } else if (i === m.lastIdx + 1 && !isNaN(m.lastEma)) {
          m.prevEma = m.lastEma
          m.lastIdx = i
          m.lastEma = bars[i].close * k + m.prevEma * (1 - k)
          m.s.update({ time: t, value: m.lastEma })
        } else {
          const r = emaSeries(bars, L)
          m.s.setData(r.data)
          m.prevEma = r.prevEma
          m.lastEma = r.lastEma
          m.lastIdx = i
        }
      }
    }
    for (const b of this.bbs) {
      const L = b.def.length ?? 20, mult = b.def.mult ?? 2
      if (i < L - 1) continue
      const { mean, sd } = bbWindow(bars, i, L)
      b.mid.update({ time: t, value: mean })
      b.up.update({ time: t, value: mean + mult * sd })
      b.lo.update({ time: t, value: mean - mult * sd })
    }
    for (const s of this.vwaps) s.update({ time: t, value: vwapAt(bars, i) })
  }

  destroy() {
    this.clear()
  }
}

/* ---------------- oscillator math (RSI / MACD) ---------------- */

export interface RsiResult { data: MaybePoint[]; lastIdx: number; prevAG: number; prevAL: number; lastAG: number; lastAL: number }

export function rsiFull(bars: Bar[], L: number): RsiResult {
  const data: MaybePoint[] = []
  let ag = NaN, al = NaN, prevAG = NaN, prevAL = NaN
  let sumG = 0, sumL = 0
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].time as UTCTimestamp
    if (i === 0) { data.push({ time: t }); continue }
    const ch = bars[i].close - bars[i - 1].close
    const g = Math.max(0, ch), l = Math.max(0, -ch)
    if (i <= L) {
      sumG += g; sumL += l
      if (i < L) { data.push({ time: t }); continue }
      ag = sumG / L; al = sumL / L
    } else {
      prevAG = ag; prevAL = al
      ag = (ag * (L - 1) + g) / L
      al = (al * (L - 1) + l) / L
    }
    data.push({ time: t, value: al === 0 ? 100 : 100 - 100 / (1 + ag / al) })
  }
  return { data, lastIdx: bars.length - 1, prevAG, prevAL, lastAG: ag, lastAL: al }
}

export function rsiLast(bars: Bar[], L: number, st: RsiResult): number | null {
  const i = bars.length - 1
  if (i < 1) return null
  const ch = bars[i].close - bars[i - 1].close
  const g = Math.max(0, ch), l = Math.max(0, -ch)
  if (i === st.lastIdx && !isNaN(st.prevAG)) {
    st.lastAG = (st.prevAG * (L - 1) + g) / L
    st.lastAL = (st.prevAL * (L - 1) + l) / L
  } else if (i === st.lastIdx + 1 && !isNaN(st.lastAG)) {
    st.prevAG = st.lastAG; st.prevAL = st.lastAL; st.lastIdx = i
    st.lastAG = (st.prevAG * (L - 1) + g) / L
    st.lastAL = (st.prevAL * (L - 1) + l) / L
  } else {
    return null // caller should do a full recompute
  }
  return st.lastAL === 0 ? 100 : 100 - 100 / (1 + st.lastAG / st.lastAL)
}

interface EmaChain { prev: number; last: number }

export interface MacdResult {
  macd: MaybePoint[]
  signal: MaybePoint[]
  hist: ({ time: UTCTimestamp; value: number; color: string } | { time: UTCTimestamp })[]
  lastIdx: number
  fastC: EmaChain
  slowC: EmaChain
  sigC: EmaChain
}

const HIST_UP = 'rgba(12,163,12,0.6)'
const HIST_DOWN = 'rgba(208,59,59,0.6)'

export function macdFull(bars: Bar[], F: number, S: number, G: number): MacdResult {
  const k = (L: number) => 2 / (L + 1)
  const kf = k(F), ks = k(S), kg = k(G)
  const macd: MaybePoint[] = [], signal: MaybePoint[] = [], hist: MacdResult['hist'] = []
  let fast = NaN, slow = NaN, sig = NaN
  let fSeed = 0, sSeed = 0, gSeed = 0, gCount = 0
  const fastC: EmaChain = { prev: NaN, last: NaN }
  const slowC: EmaChain = { prev: NaN, last: NaN }
  const sigC: EmaChain = { prev: NaN, last: NaN }
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].close
    const t = bars[i].time as UTCTimestamp
    if (i < F - 1) fSeed += c
    else if (i === F - 1) { fSeed += c; fast = fSeed / F } else { fastC.prev = fast; fast = c * kf + fast * (1 - kf) }
    if (i < S - 1) sSeed += c
    else if (i === S - 1) { sSeed += c; slow = sSeed / S } else { slowC.prev = slow; slow = c * ks + slow * (1 - ks) }
    if (isNaN(slow) || isNaN(fast)) { macd.push({ time: t }); signal.push({ time: t }); hist.push({ time: t }); continue }
    const m = fast - slow
    macd.push({ time: t, value: m })
    if (gCount < G - 1) { gSeed += m; gCount++; signal.push({ time: t }); hist.push({ time: t }); continue }
    if (gCount === G - 1) { gSeed += m; gCount++; sig = gSeed / G } else { sigC.prev = sig; sig = m * kg + sig * (1 - kg) }
    signal.push({ time: t, value: sig })
    const h = m - sig
    hist.push({ time: t, value: h, color: h >= 0 ? HIST_UP : HIST_DOWN })
  }
  fastC.last = fast; slowC.last = slow; sigC.last = sig
  return { macd, signal, hist, lastIdx: bars.length - 1, fastC, slowC, sigC }
}

export function macdLast(bars: Bar[], F: number, S: number, G: number, st: MacdResult): { macd: number; signal: number; hist: number } | null {
  const i = bars.length - 1
  if (i < 0) return null
  const c = bars[i].close
  const k = (L: number) => 2 / (L + 1)
  const step = (chain: EmaChain, kk: number, input: number, shift: boolean) => {
    if (shift) chain.prev = chain.last
    chain.last = input * kk + chain.prev * (1 - kk)
    return chain.last
  }
  let shift: boolean
  if (i === st.lastIdx && !isNaN(st.fastC.prev) && !isNaN(st.slowC.prev) && !isNaN(st.sigC.prev)) shift = false
  else if (i === st.lastIdx + 1 && !isNaN(st.fastC.last) && !isNaN(st.slowC.last) && !isNaN(st.sigC.last)) { shift = true; st.lastIdx = i }
  else return null
  const fast = step(st.fastC, k(F), c, shift)
  const slow = step(st.slowC, k(S), c, shift)
  const m = fast - slow
  const sig = step(st.sigC, k(G), m, shift)
  return { macd: m, signal: sig, hist: m - sig }
}

export { HIST_UP, HIST_DOWN }
