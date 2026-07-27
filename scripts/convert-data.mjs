// One-time converter: <SYMBOL>.txt in the sibling instruments-data/ folder (1-min bars, GMT, bid) ->
// chunked binary files + manifest under public/data/<SYMBOL>/.
// Usage: node scripts/convert-data.mjs [SYMBOL ...]   (default: XAUUSD EURUSD GBPUSD, existing files only)
// Source layout: ../instruments-data/<SYMBOL>.txt, i.e. instruments-data/ sits next to this
// project's own folder (see README.md > "Adding an instrument").
// Conversion logic lives in scripts/lib/convertInstrument.mjs, shared with the in-app
// Instruments importer (vite.config.ts dev server, Electron main process).
import fs from 'node:fs'
import path from 'node:path'
import { convertInstrument } from './lib/convertInstrument.mjs'

const SOURCE_DIR = path.join(import.meta.dirname, '..', '..', 'instruments-data')

async function convert(symbol) {
  const src = path.join(SOURCE_DIR, `${symbol}.txt`)
  const out = path.join(import.meta.dirname, '..', 'public', 'data', symbol)
  if (!fs.existsSync(src)) {
    console.log(`SKIP ${symbol}: ${src} not found`)
    return
  }
  console.log(`\n=== ${symbol} ===`)
  const r = await convertInstrument({
    symbol,
    source: fs.createReadStream(src),
    outDir: out,
    onProgress: (rows, monthKey) => console.log(`  ${symbol}: ${rows} rows... (${monthKey})`),
  })
  console.log(`  DONE ${symbol}: ${r.rows} bars, ${r.dropped} dropped.`)
  console.log(`  Range: ${new Date(r.from * 1000).toISOString()} -> ${new Date(r.to * 1000).toISOString()}`)
}

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['XAUUSD', 'EURUSD', 'GBPUSD']
for (const s of symbols) await convert(s.toUpperCase())
