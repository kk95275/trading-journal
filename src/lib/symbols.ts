// Per-symbol contract specs. XAUUSD: 1 lot = 100 oz, $1.00 move = $100/lot.
// FX majors: 1 lot = 100,000 units, 0.0001 move (1 pip) = $10/lot (USD-quoted).
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

export const SYMBOL_LIST = Object.keys(SYMBOLS)

export function specFor(symbol: string): SymbolSpec {
  return SYMBOLS[symbol] ?? { symbol, name: symbol, contractSize: 100, decimals: 2, inputStep: 0.1, defaultSpread: 0.3 }
}

export const fmtPx = (v: number, symbol: string) => v.toFixed(specFor(symbol).decimals)
