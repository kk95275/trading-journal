// Per-symbol contract specs. XAUUSD: 1 lot = 100 oz, $1.00 move = $100/lot.
// FX majors: 1 lot = 100,000 units, 0.0001 move (1 pip) = $10/lot (USD-quoted).
//
// specFor() is called synchronously in hot paths (gold.ts P&L math, replay/engine.ts,
// ReplayChart.tsx render) so it can't become async. Instead, `registry` is a module-level
// array populated ahead of time by refreshInstruments() (src/lib/instruments.ts) from
// whatever instruments actually exist on disk, with pub-sub so React re-renders when it
// changes (a plain mutated array wouldn't trigger a re-render on its own).
export interface SymbolSpec {
  symbol: string
  name: string
  contractSize: number // units per lot: P&L = move × contractSize × lots
  decimals: number     // price display decimals
  inputStep: number    // step for SL/TP inputs
  defaultSpread: number
}

export const SYMBOLS: Record<string, SymbolSpec> = {
  XAUUSD: { symbol: 'XAUUSD', name: 'Gold', contractSize: 100, decimals: 2, inputStep: 0.1, defaultSpread: 0.3 },
  EURUSD: { symbol: 'EURUSD', name: 'Euro / USD', contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.0001 },
  GBPUSD: { symbol: 'GBPUSD', name: 'Pound / USD', contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.00015 },
}

export interface InstrumentEntry { symbol: string; spec?: SymbolSpec }

let registry: InstrumentEntry[] = []
const listeners = new Set<() => void>()

export function onInstrumentsChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Called by refreshInstruments() after listing what's actually on disk. */
export function setInstrumentRegistry(entries: InstrumentEntry[]): void {
  registry = entries
  for (const fn of listeners) fn()
}

/** Falls back to the built-in 3 symbols before the first refresh resolves. */
export function getSymbolList(): string[] {
  return registry.length ? registry.map(e => e.symbol) : Object.keys(SYMBOLS)
}

export function specFor(symbol: string): SymbolSpec {
  const dyn = registry.find(e => e.symbol === symbol)?.spec
  if (dyn) return dyn // 1. user-entered spec from import, wins
  return (
    SYMBOLS[symbol] ?? // 2. built-in XAUUSD/EURUSD/GBPUSD defaults
    { symbol, name: symbol, contractSize: 100, decimals: 2, inputStep: 0.1, defaultSpread: 0.3 } // 3. generic fallback
  )
}

export const fmtPx = (v: number, symbol: string) => v.toFixed(specFor(symbol).decimals)
