// Shared conversion core: raw <SYMBOL>.txt lines (1-min bars, GMT, bid) -> chunked binary
// files + manifest.json under outDir. Same code, three call sites: the CLI (scripts/convert-data.mjs),
// the Vite dev-server instruments API (vite.config.ts), and Electron's main process (electron/main.cts).
// Binary format per bar (24 bytes LE): uint32 epochSeconds, float32 open, high, low, close, volume.
// 1m is chunked by month; 5m/15m by year; 1h/4h/1d are single files.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export const BAR_BYTES = 24
const AGG_TFS = [
  { name: '5m', sec: 300, split: 'year' },
  { name: '15m', sec: 900, split: 'year' },
  { name: '1h', sec: 3600, split: 'all' },
  { name: '4h', sec: 14400, split: 'all' },
  { name: '1d', sec: 86400, split: 'all' },
]

/**
 * @param {object} args
 * @param {string} args.symbol             uppercase ticker, e.g. 'XAUUSD'
 * @param {NodeJS.ReadableStream} args.source  raw <SYMBOL>.txt content (line-delimited:
 *        header line starting with '<' ignored, then <TICKER>,<DTYYYYMMDD>,<TIME>,<O>,<H>,<L>,<C>,<VOL>)
 * @param {string} args.outDir             absolute path to write manifest.json + chunks into
 * @param {{name:string,contractSize:number,decimals:number,inputStep:number,defaultSpread:number}} [args.spec]
 *        optional — embedded into manifest.json as `spec` if provided
 * @param {(rows:number, monthKey:string) => void} [args.onProgress]  called every 1,000,000 rows
 * @returns {Promise<{rows:number, dropped:number, from:number|null, to:number|null}>}
 */
export async function convertInstrument({ symbol, source, outDir, spec, onProgress }) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, '1m'), { recursive: true })
  for (const tf of AGG_TFS) fs.mkdirSync(path.join(outDir, tf.name), { recursive: true })

  const manifest = { symbol, priceBasis: 'bid', timezone: 'GMT', barBytes: BAR_BYTES, timeframes: {} }
  if (spec) manifest.spec = spec
  for (const tf of ['1m', ...AGG_TFS.map(t => t.name)]) manifest.timeframes[tf] = { chunks: [] }

  const writeChunk = (tfName, key, bars) => {
    if (!bars.length) return
    const buf = Buffer.allocUnsafe(bars.length * BAR_BYTES)
    let off = 0
    for (const b of bars) {
      buf.writeUInt32LE(b.t, off)
      buf.writeFloatLE(b.o, off + 4)
      buf.writeFloatLE(b.h, off + 8)
      buf.writeFloatLE(b.l, off + 12)
      buf.writeFloatLE(b.c, off + 16)
      buf.writeFloatLE(b.v, off + 20)
      off += BAR_BYTES
    }
    const file = `${tfName}/${key}.bin`
    fs.writeFileSync(path.join(outDir, file), buf)
    manifest.timeframes[tfName].chunks.push({ file, from: bars[0].t, to: bars[bars.length - 1].t, bars: bars.length })
  }

  const aggs = AGG_TFS.map(tf => ({ ...tf, cur: null, buf: [], key: null }))
  const pushAgg = (agg, bar) => {
    const bucket = Math.floor(bar.t / agg.sec) * agg.sec
    const key = agg.split === 'year' ? String(new Date(bucket * 1000).getUTCFullYear()) : 'all'
    if (agg.cur && (agg.cur.t !== bucket || agg.key !== key)) {
      if (agg.key !== key) {
        agg.buf.push(agg.cur)
        writeChunk(agg.name, agg.key, agg.buf)
        agg.buf = []
        agg.cur = null
      } else {
        agg.buf.push(agg.cur)
        agg.cur = null
      }
    }
    agg.key = key
    if (!agg.cur) {
      agg.cur = { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }
    } else {
      agg.cur.h = Math.max(agg.cur.h, bar.h)
      agg.cur.l = Math.min(agg.cur.l, bar.l)
      agg.cur.c = bar.c
      agg.cur.v += bar.v
    }
  }

  let monthKey = null
  let monthBuf = []
  let prevTs = 0
  let rows = 0, dropped = 0, firstTs = null, lastTs = null

  const rl = readline.createInterface({ input: source, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.startsWith('<') || !line.trim()) continue
    const p = line.split(',')
    if (p.length < 8) { dropped++; continue }
    const d = p[1], t = p[2].padStart(6, '0')
    const ts = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)) / 1000
    if (ts <= prevTs) { dropped++; continue } // out-of-order/duplicate rows
    prevTs = ts
    const bar = { t: ts, o: +p[3], h: +p[4], l: +p[5], c: +p[6], v: +p[7] }
    if (!Number.isFinite(bar.o + bar.h + bar.l + bar.c)) { dropped++; continue }
    if (firstTs === null) firstTs = ts
    lastTs = ts

    const mk = d.slice(0, 4) + '-' + d.slice(4, 6)
    if (monthKey && mk !== monthKey) { writeChunk('1m', monthKey, monthBuf); monthBuf = [] }
    monthKey = mk
    monthBuf.push(bar)

    for (const agg of aggs) pushAgg(agg, bar)

    if (++rows % 1000000 === 0 && onProgress) onProgress(rows, mk)
  }
  writeChunk('1m', monthKey, monthBuf)
  for (const agg of aggs) {
    if (agg.cur) agg.buf.push(agg.cur)
    writeChunk(agg.name, agg.key, agg.buf)
  }

  manifest.from = firstTs
  manifest.to = lastTs
  manifest.rows = rows
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1))
  return { rows, dropped, from: firstTs, to: lastTs }
}
