// Bridges platform.ts (where instrument data actually lives) to symbols.ts's reactive
// registry (what specFor()/the symbol pickers read). Call refreshInstruments() once at
// app startup and again after any import/delete so the UI picks up changes immediately.
import { useEffect, useState } from 'react'
import { platform, type InstrumentInfo } from './platform'
import { setInstrumentRegistry, getSymbolList, onInstrumentsChange } from './symbols'

export async function refreshInstruments(): Promise<InstrumentInfo[]> {
  const list = await platform.listInstruments()
  setInstrumentRegistry(list.map(i => ({ symbol: i.symbol, spec: i.spec })))
  return list
}

/** Reactive symbol list — re-renders the consuming component after refreshInstruments(). */
export function useSymbolList(): string[] {
  const [list, setList] = useState(getSymbolList())
  useEffect(() => onInstrumentsChange(() => setList(getSymbolList())), [])
  return list
}
