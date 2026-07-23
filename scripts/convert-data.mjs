// One-time converter: <SYMBOL>.txt in the sibling instruments-data/ folder (1-min bars, GMT, bid) ->
// chunked binary files + manifest under public/data/<SYMBOL>/.
// Binary format per bar (24 bytes LE): uint32 epochSeconds, float32 open, high, low, close, volume.
// 1m is chunked by month; 5m/15m by year; 1h/4h/1d are single files.
// Usage: node scripts/convert-data.mjs [SYMBOL ...]   (default: XAUUSD EURUSD GBPUSD, existing files only)
// Source layout: ../instruments-data/<SYMBOL>.txt, i.e. instruments-data/ sits next to this
// project's own folder (see README.md > "Adding your own instrument").
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const SOURCE_DIR = path.join(import.meta.dirname, '..', '..', 'instruments-data')
const BAR_BYTES = 24
const AGG_TFS = [
  { name: '5m', sec: 300, split: 'year' },
  { name: '15m', sec: 900, split: 'year' },
  { name: '1h', sec: 3600, split: 'all' },
  { name: '4h', sec: 14400, split: 'all' },
  { name: '1d', sec: 86400, split: 'all' },
]

async function convert(symbol) {
  const src = path.join(SOURCE_DIR, `${symbol}.txt`)
  const out = path.join(import.meta.dirname, '..', 'public', 'data', symbol)
  if (!fs.existsSync(src)) {
    console.log(`SKIP ${symbol}: ${src} not found`)
    return
  }
  console.log(`\n=== ${symbol} ===`)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, '1m'), { recursive: true })
  for (const tf of AGG_TFS) fs.mkdirSync(path.join(out, tf.name), { recursive: true })

  const manifest = { symbol, priceBasis: 'bid', timezone: 'GMT', barBytes: BAR_BYTES, timeframes: {} }
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
    fs.writeFileSync(path.join(out, file), buf)
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

  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity })
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

    if (++rows % 1000000 === 0) console.log(`  ${symbol}: ${rows} rows... (${mk})`)
  }
  writeChunk('1m', monthKey, monthBuf)
  for (const agg of aggs) {
    if (agg.cur) agg.buf.push(agg.cur)
    writeChunk(agg.name, agg.key, agg.buf)
  }

  manifest.from = firstTs
  manifest.to = lastTs
  manifest.rows = rows
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1))
  console.log(`  DONE ${symbol}: ${rows} bars, ${dropped} dropped.`)
  console.log(`  Range: ${new Date(firstTs * 1000).toISOString()} -> ${new Date(lastTs * 1000).toISOString()}`)
}

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['XAUUSD', 'EURUSD', 'GBPUSD']
for (const s of symbols) await convert(s.toUpperCase())
