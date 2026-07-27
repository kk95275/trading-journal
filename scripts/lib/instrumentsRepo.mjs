// Enumerate/delete converted instruments under a data directory (public/data/ in dev,
// the OS user-data dir's instruments/ folder when packaged in Electron).
import fs from 'node:fs'
import path from 'node:path'

const SYMBOL_RE = /^[A-Z0-9_.-]+$/i

export function isValidSymbol(symbol) {
  return typeof symbol === 'string' && symbol.length > 0 && SYMBOL_RE.test(symbol)
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

/** @returns {Array<{symbol:string, from:number, to:number, rows:number, sizeBytes:number, spec?:object}>} */
export function listInstruments(dataDir) {
  if (!fs.existsSync(dataDir)) return []
  const out = []
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const symbol = entry.name
    const manifestPath = path.join(dataDir, symbol, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      out.push({
        symbol,
        from: manifest.from,
        to: manifest.to,
        rows: manifest.rows,
        sizeBytes: dirSize(path.join(dataDir, symbol)),
        spec: manifest.spec,
      })
    } catch {
      // skip a corrupt/partial manifest rather than fail the whole list
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export function deleteInstrument(dataDir, symbol) {
  if (!isValidSymbol(symbol)) throw new Error(`bad symbol: ${symbol}`)
  fs.rmSync(path.join(dataDir, symbol), { recursive: true, force: true })
}
