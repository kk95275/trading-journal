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
  contractSize: number // units per lot: raw P&L = move × contractSize × lots (in quote currency)
  decimals: number     // price display decimals
  inputStep: number    // step for SL/TP inputs
  defaultSpread: number
  /**
   * Multiplier applied to raw P&L to convert QUOTE currency → USD.
   * USD-quoted pairs (EURUSD, GBPUSD, XAUUSD): omit or set 1.
   * JPY-quoted (USDJPY, GBPJPY, EURJPY, …): ~1/USDJPY, so at USDJPY=150 use ≈0.00667.
   * Base-USD pairs where quote is CHF/CAD: ~1/spot, so USDCHF at 0.90 uses ≈1.111.
   * Cross like EURGBP (quote GBP): ~GBPUSD (~1.27).
   * Users can override any built-in default via Settings → Instruments (Add instrument).
   */
  quoteToUsd?: number
}

// Static "current-era" (2026) approximations for pairs whose quote currency isn't USD.
// Kept in one place so future refreshes are a single-file edit.
const JPY_TO_USD    = 1 / 150   // ≈ 1/USDJPY
const CHF_TO_USD    = 1 / 0.90  // ≈ 1/USDCHF
const CAD_TO_USD    = 1 / 1.35  // ≈ 1/USDCAD

export const SYMBOLS: Record<string, SymbolSpec> = {
  // Metals (USD-quoted)
  XAUUSD: { symbol: 'XAUUSD', name: 'Gold',   contractSize: 100,  decimals: 2, inputStep: 0.1,   defaultSpread: 0.3 },
  XAGUSD: { symbol: 'XAGUSD', name: 'Silver', contractSize: 5000, decimals: 3, inputStep: 0.001, defaultSpread: 0.03 },

  // USD-quoted FX (no conversion needed)
  EURUSD: { symbol: 'EURUSD', name: 'Euro / USD',   contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.0001 },
  GBPUSD: { symbol: 'GBPUSD', name: 'Pound / USD',  contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.00015 },
  AUDUSD: { symbol: 'AUDUSD', name: 'Aussie / USD', contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.0001 },
  NZDUSD: { symbol: 'NZDUSD', name: 'Kiwi / USD',   contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.00015 },

  // Base-USD pairs (quote is not USD — needs conversion)
  USDCHF: { symbol: 'USDCHF', name: 'USD / Swiss Franc',      contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.0002, quoteToUsd: CHF_TO_USD },
  USDCAD: { symbol: 'USDCAD', name: 'USD / Canadian Dollar',  contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.0002, quoteToUsd: CAD_TO_USD },

  // JPY-quoted (3 decimals, pip = 0.01)
  USDJPY: { symbol: 'USDJPY', name: 'USD / Yen',          contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.01,  quoteToUsd: JPY_TO_USD },
  EURJPY: { symbol: 'EURJPY', name: 'Euro / Yen',         contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.015, quoteToUsd: JPY_TO_USD },
  GBPJPY: { symbol: 'GBPJPY', name: 'Pound / Yen',        contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.02,  quoteToUsd: JPY_TO_USD },
  AUDJPY: { symbol: 'AUDJPY', name: 'Aussie / Yen',       contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.02,  quoteToUsd: JPY_TO_USD },
  CHFJPY: { symbol: 'CHFJPY', name: 'Swiss Franc / Yen',  contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.025, quoteToUsd: JPY_TO_USD },
  CADJPY: { symbol: 'CADJPY', name: 'Canadian Dollar / Yen', contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.025, quoteToUsd: JPY_TO_USD },
  NZDJPY: { symbol: 'NZDJPY', name: 'Kiwi / Yen',         contractSize: 100000, decimals: 3, inputStep: 0.01, defaultSpread: 0.025, quoteToUsd: JPY_TO_USD },
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
