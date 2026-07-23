// Loads the chunked binary bar data produced by scripts/convert-data.mjs,
// per symbol (public/data/<SYMBOL>/...).
// Format per bar (24 bytes LE): uint32 epochSeconds, float32 o, h, l, c, v.
import type { Bar } from '../lib/types'

export type TfName = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const TF_SECONDS: Record<TfName, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
}
export const TF_LIST: TfName[] = ['1m', '5m', '15m', '1h', '4h', '1d']

interface Chunk { file: string; from: number; to: number; bars: number }
export interface Manifest {
  symbol: string
  priceBasis: string
  timezone: string
  barBytes: number
  from: number
  to: number
  rows: number
  timeframes: Record<string, { chunks: Chunk[] }>
}

const BAR_BYTES = 24

const manifestPromises = new Map<string, Promise<Manifest>>()
const chunkCache = new Map<string, Bar[]>() // key: `${symbol}/${file}`
const chunkOrder: string[] = [] // LRU for 1m chunks
const MAX_1M_CHUNKS = 40

export function getManifest(symbol: string): Promise<Manifest> {
  let p = manifestPromises.get(symbol)
  if (!p) {
    p = fetch(`/data/${symbol}/manifest.json`).then(r => {
      if (!r.ok) throw new Error(`No data for ${symbol} — run: npm run convert-data`)
      return r.json()
    })
    p.catch(() => manifestPromises.delete(symbol)) // don't cache failures
    manifestPromises.set(symbol, p)
  }
  return p
}

function parseChunk(buf: ArrayBuffer): Bar[] {
  const view = new DataView(buf)
  const n = Math.floor(buf.byteLength / BAR_BYTES)
  const bars: Bar[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const off = i * BAR_BYTES
    bars[i] = {
      time: view.getUint32(off, true),
      open: view.getFloat32(off + 4, true),
      high: view.getFloat32(off + 8, true),
      low: view.getFloat32(off + 12, true),
      close: view.getFloat32(off + 16, true),
      volume: view.getFloat32(off + 20, true),
    }
  }
  return bars
}

async function loadChunk(symbol: string, chunk: Chunk): Promise<Bar[]> {
  const key = `${symbol}/${chunk.file}`
  const cached = chunkCache.get(key)
  if (cached) return cached
  const res = await fetch(`/data/${symbol}/${chunk.file}`)
  if (!res.ok) throw new Error(`Failed to load ${key}`)
  const bars = parseChunk(await res.arrayBuffer())
  chunkCache.set(key, bars)
  if (chunk.file.startsWith('1m/')) {
    chunkOrder.push(key)
    while (chunkOrder.length > MAX_1M_CHUNKS) {
      const evict = chunkOrder.shift()!
      chunkCache.delete(evict)
    }
  }
  return bars
}

export async function chunksFor(symbol: string, tf: TfName): Promise<Chunk[]> {
  const m = await getManifest(symbol)
  return m.timeframes[tf].chunks
}

/** All bars of `tf` with time in [fromSec, toSec]. */
export async function getBars(symbol: string, tf: TfName, fromSec: number, toSec: number): Promise<Bar[]> {
  const chunks = (await chunksFor(symbol, tf)).filter(c => c.to >= fromSec && c.from <= toSec)
  const parts = await Promise.all(chunks.map(c => loadChunk(symbol, c)))
  const out: Bar[] = []
  for (const part of parts) {
    for (const b of part) if (b.time >= fromSec && b.time <= toSec) out.push(b)
  }
  return out
}

/** Up to `count` bars of `tf` strictly before `beforeSec` (for chart left-context). */
export async function getBarsBefore(symbol: string, tf: TfName, beforeSec: number, count: number): Promise<Bar[]> {
  const chunks = (await chunksFor(symbol, tf)).filter(c => c.from < beforeSec)
  const out: Bar[] = []
  for (let i = chunks.length - 1; i >= 0 && out.length < count; i--) {
    const part = await loadChunk(symbol, chunks[i])
    for (let j = part.length - 1; j >= 0; j--) {
      const b = part[j]
      if (b.time < beforeSec) {
        out.push(b)
        if (out.length >= count) break
      }
    }
  }
  return out.reverse()
}

/** Largest precomputed timeframe that divides `tfSec` evenly (aggregation base). */
export function baseTfFor(tfSec: number): TfName {
  const order: TfName[] = ['1d', '4h', '1h', '15m', '5m', '1m']
  for (const t of order) if (tfSec % TF_SECONDS[t] === 0) return t
  return '1m'
}

/**
 * Up to `count` bars of an arbitrary timeframe (seconds) strictly before `beforeSec`.
 * Uses a precomputed timeframe directly when one matches, otherwise aggregates
 * from the largest precomputed timeframe that divides it. `beforeSec` should be
 * aligned to a `tfSec` bucket boundary.
 */
export async function getContextBars(symbol: string, tfSec: number, beforeSec: number, count: number): Promise<Bar[]> {
  const exact = TF_LIST.find(t => TF_SECONDS[t] === tfSec)
  if (exact) return getBarsBefore(symbol, exact, beforeSec, count)
  const base = baseTfFor(tfSec)
  const ratio = tfSec / TF_SECONDS[base]
  const raw = await getBarsBefore(symbol, base, beforeSec, Math.ceil(count * ratio) + ratio)
  // first aggregated bucket may be partial (raw window starts mid-bucket) — drop it
  return aggregate(raw, tfSec).slice(1).filter(b => b.time < beforeSec).slice(-count)
}

/** Aggregate 1m bars into `tfSec` buckets (bucket start = floor(t / tfSec) * tfSec). */
export function aggregate(bars1m: Bar[], tfSec: number): Bar[] {
  const out: Bar[] = []
  let cur: Bar | null = null
  for (const b of bars1m) {
    const bucket = Math.floor(b.time / tfSec) * tfSec
    if (cur && cur.time === bucket) {
      if (b.high > cur.high) cur.high = b.high
      if (b.low < cur.low) cur.low = b.low
      cur.close = b.close
      cur.volume += b.volume
    } else {
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
      out.push(cur)
    }
  }
  return out
}
