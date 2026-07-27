// Runtime adapter: the app runs either as a plain browser tab against the Vite dev
// server (fetch-based, talking to vite.config.ts's middlewares) or inside Electron
// (IPC-based, talking to electron/main.cts via the electron/preload.cts bridge).
// Everything that needs to read/write local files goes through this one interface so
// dataService.ts, sync.ts, and the Instruments UI don't need to know which runtime they're in.
import type { SymbolSpec } from './symbols'

export interface Chunk { file: string; from: number; to: number; bars: number }
export interface Manifest {
  symbol: string
  priceBasis: string
  timezone: string
  barBytes: number
  from: number
  to: number
  rows: number
  timeframes: Record<string, { chunks: Chunk[] }>
  spec?: SymbolSpec
}
export interface InstrumentInfo { symbol: string; from: number; to: number; rows: number; sizeBytes: number; spec?: SymbolSpec }
export interface ConvertResult { rows: number; dropped: number; from: number; to: number }
export interface JournalMeta { exportedAt?: string; trades?: number; accounts?: number }

export interface ImportInstrumentArgs {
  symbol: string
  spec: SymbolSpec
  file?: File       // web: the raw <SYMBOL>.txt picked via <input type="file">
  filePath?: string // electron: absolute path picked via the native dialog
}

export interface Platform {
  getJournal(): Promise<any | null>
  putJournal(snapshot: unknown, meta: JournalMeta): Promise<void>
  getJournalMeta(): Promise<JournalMeta>
  getManifest(symbol: string): Promise<Manifest>
  getChunk(symbol: string, file: string): Promise<ArrayBuffer>
  listInstruments(): Promise<InstrumentInfo[]>
  deleteInstrument(symbol: string): Promise<void>
  pickInstrumentFile(): Promise<string | null> // web always resolves null — UI falls back to <input type="file">
  importInstrument(args: ImportInstrumentArgs, onProgress: (rows: number, monthKey: string) => void): Promise<ConvertResult>
}

declare global {
  interface Window {
    electronAPI?: {
      getJournal(): Promise<any | null>
      putJournal(snapshot: unknown, meta: JournalMeta): Promise<void>
      getJournalMeta(): Promise<JournalMeta>
      getManifest(symbol: string): Promise<Manifest>
      getChunk(symbol: string, file: string): Promise<ArrayBuffer>
      listInstruments(): Promise<InstrumentInfo[]>
      deleteInstrument(symbol: string): Promise<void>
      pickInstrumentFile(): Promise<string | null>
      importInstrument(
        args: { symbol: string; filePath: string; spec: SymbolSpec },
        onProgress: (rows: number, monthKey: string) => void,
      ): Promise<ConvertResult>
    }
  }
}

export const isElectron = typeof window !== 'undefined' && !!window.electronAPI

const webPlatform: Platform = {
  async getJournal() {
    const res = await fetch('/api/journal')
    if (!res.ok) return null
    return res.json()
  },
  async putJournal(snapshot, meta) {
    const res = await fetch('/api/journal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-journal-meta': JSON.stringify(meta) },
      body: JSON.stringify(snapshot),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
  },
  async getJournalMeta() {
    const res = await fetch('/api/journal-meta')
    return res.ok ? res.json() : {}
  },
  async getManifest(symbol) {
    const res = await fetch(`/data/${symbol}/manifest.json`)
    if (!res.ok) throw new Error(`No data for ${symbol} — run: npm run convert-data`)
    return res.json()
  },
  async getChunk(symbol, file) {
    const res = await fetch(`/data/${symbol}/${file}`)
    if (!res.ok) throw new Error(`Failed to load ${symbol}/${file}`)
    return res.arrayBuffer()
  },
  async listInstruments() {
    const res = await fetch('/api/instruments')
    if (!res.ok) throw new Error('Failed to list instruments')
    return res.json()
  },
  async deleteInstrument(symbol) {
    const res = await fetch(`/api/instruments/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Failed to delete ${symbol}`)
  },
  async pickInstrumentFile() {
    return null
  },
  async importInstrument({ symbol, spec, file }, onProgress) {
    if (!file) throw new Error('No file selected')
    const res = await fetch(`/api/instruments/import?symbol=${encodeURIComponent(symbol)}`, {
      method: 'POST',
      headers: { 'x-instrument-spec': JSON.stringify(spec) },
      body: file,
    })
    if (!res.ok || !res.body) throw new Error(`Import failed (${res.status})`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        const evt = JSON.parse(line)
        if (evt.error) throw new Error(evt.error)
        if (evt.done) return evt as ConvertResult
        onProgress(evt.rows, evt.monthKey)
      }
    }
    throw new Error('Import stream ended unexpectedly')
  },
}

const electronPlatform: Platform = {
  getJournal: () => window.electronAPI!.getJournal(),
  putJournal: (snapshot, meta) => window.electronAPI!.putJournal(snapshot, meta),
  getJournalMeta: () => window.electronAPI!.getJournalMeta(),
  getManifest: symbol => window.electronAPI!.getManifest(symbol),
  getChunk: (symbol, file) => window.electronAPI!.getChunk(symbol, file),
  listInstruments: () => window.electronAPI!.listInstruments(),
  deleteInstrument: symbol => window.electronAPI!.deleteInstrument(symbol),
  pickInstrumentFile: () => window.electronAPI!.pickInstrumentFile(),
  importInstrument: ({ symbol, spec, filePath }, onProgress) => {
    if (!filePath) throw new Error('No file selected')
    return window.electronAPI!.importInstrument({ symbol, filePath, spec }, onProgress)
  },
}

export const platform: Platform = isElectron ? electronPlatform : webPlatform
