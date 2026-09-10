// Settings-page card: list/import/delete OHLCV chart data from the running app, no
// terminal or source-code edits needed. Writes the same binary format/manifest that
// scripts/convert-data.mjs produces (shared scripts/lib/convertInstrument.mjs).
import { useEffect, useState } from 'react'
import { fmtDate } from '../lib/gold'
import { SYMBOLS, type SymbolSpec } from '../lib/symbols'
import { refreshInstruments } from '../lib/instruments'
import { platform, isElectron, type InstrumentInfo } from '../lib/platform'
import { invalidateManifest } from '../data/dataService'
import { Modal } from './ui'

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

export default function InstrumentsCard() {
  const [instruments, setInstruments] = useState<InstrumentInfo[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  const load = async () => {
    const list = await refreshInstruments()
    setInstruments(list)
  }

  useEffect(() => { void load() }, [])

  const del = async (symbol: string) => {
    if (!confirm(`Delete all chart data for ${symbol}? This cannot be undone (re-import to restore).`)) return
    await platform.deleteInstrument(symbol)
    invalidateManifest(symbol)
    setMsg(`Deleted ${symbol}.`)
    await load()
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">Instruments</h3>
        <button className="btn-primary text-xs" onClick={() => setAdding(true)}>+ Add instrument</button>
      </div>
      {!instruments?.length ? (
        <div className="text-xs text-muted">No chart data yet — add an instrument to start backtesting.</div>
      ) : (
        <table className="w-full">
          <thead>
            <tr><th className="th">Symbol</th><th className="th">Name</th><th className="th">Range</th><th className="th">Bars</th><th className="th">Size</th><th className="th" /></tr>
          </thead>
          <tbody>
            {instruments.map(i => (
              <tr key={i.symbol}>
                <td className="td text-ink">{i.symbol}</td>
                <td className="td text-muted">{i.spec?.name ?? SYMBOLS[i.symbol]?.name ?? '—'}</td>
                <td className="td text-muted">{fmtDate(i.from)} → {fmtDate(i.to)}</td>
                <td className="td">{i.rows.toLocaleString()}</td>
                <td className="td">{fmtBytes(i.sizeBytes)}</td>
                <td className="td text-right">
                  <button className="btn-ghost text-xs !text-down" onClick={() => del(i.symbol)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <div className="text-xs text-warn mt-2">{msg}</div>}
      <p className="text-[11px] text-muted mt-2">1-min OHLCV, GMT (no DST), bid prices recommended — see README.md &gt; "Adding an instrument".</p>
      {adding && (
        <AddInstrument
          onClose={() => setAdding(false)}
          onDone={async () => { await load(); setMsg('Instrument imported.') }}
        />
      )}
    </div>
  )
}

function AddInstrument({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [contractSize, setContractSize] = useState(100000)
  const [decimals, setDecimals] = useState(5)
  const [inputStep, setInputStep] = useState(0.0001)
  const [defaultSpread, setDefaultSpread] = useState(0.0001)
  const [quoteToUsd, setQuoteToUsd] = useState(1)
  const [file, setFile] = useState<File | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ rows: number; monthKey: string } | null>(null)
  const [error, setError] = useState('')

  const quickFill = (spec: SymbolSpec) => {
    setName(spec.name)
    setContractSize(spec.contractSize)
    setDecimals(spec.decimals)
    setInputStep(spec.inputStep)
    setDefaultSpread(spec.defaultSpread)
    setQuoteToUsd(spec.quoteToUsd ?? 1)
  }

  const pickFile = async () => {
    const path = await platform.pickInstrumentFile()
    if (path) setFilePath(path)
  }

  const submit = async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) { setError('Symbol is required'); return }
    if (!/^[A-Z0-9_.-]+$/.test(sym)) { setError('Symbol can only contain letters, numbers, - _ .'); return }
    if (!file && !filePath) { setError('Choose a file'); return }
    setError('')
    setBusy(true)
    setProgress(null)
    try {
      const spec: SymbolSpec = {
        symbol: sym,
        name: name.trim() || sym,
        contractSize, decimals, inputStep, defaultSpread,
        ...(quoteToUsd !== 1 ? { quoteToUsd } : {}),
      }
      await platform.importInstrument(
        { symbol: sym, spec, file: file ?? undefined, filePath: filePath ?? undefined },
        (rows, monthKey) => setProgress({ rows, monthKey }),
      )
      invalidateManifest(sym)
      await onDone()
      onClose()
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add instrument" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          Raw file format: one header line, then <span className="text-ink2">SYMBOL,YYYYMMDD,HHMMSS,open,high,low,close,volume</span> per
          1-minute bar — GMT (no DST), bid prices recommended.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Symbol</label>
            <input className="input" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. NZDUSD" />
          </div>
          <div>
            <label className="label">Display name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. NZ Dollar / USD" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => quickFill(SYMBOLS.XAUUSD)}>Fill metal-like (XAUUSD)</button>
          <button type="button" className="btn-ghost text-xs" onClick={() => quickFill(SYMBOLS.EURUSD)}>Fill USD-quoted FX (EURUSD)</button>
          <button type="button" className="btn-ghost text-xs" onClick={() => quickFill(SYMBOLS.GBPJPY)}>Fill JPY-quoted FX (GBPJPY)</button>
          <button type="button" className="btn-ghost text-xs" onClick={() => quickFill(SYMBOLS.USDCHF)}>Fill USD-based (USDCHF)</button>
        </div>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
          <div><label className="label">Contract size</label><input type="number" className="input" value={contractSize} onChange={e => setContractSize(+e.target.value)} /></div>
          <div><label className="label">Decimals</label><input type="number" className="input" value={decimals} onChange={e => setDecimals(+e.target.value)} /></div>
          <div><label className="label">Input step</label><input type="number" step="any" className="input" value={inputStep} onChange={e => setInputStep(+e.target.value)} /></div>
          <div><label className="label">Default spread</label><input type="number" step="any" className="input" value={defaultSpread} onChange={e => setDefaultSpread(+e.target.value)} /></div>
          <div>
            <label className="label" title="Multiplier converting quote-currency P&L → USD. USD-quoted pairs use 1. For JPY pairs use ~1/USDJPY (≈0.00667 at USDJPY=150).">
              Quote→USD
            </label>
            <input type="number" step="any" className="input" value={quoteToUsd} onChange={e => setQuoteToUsd(+e.target.value)} />
          </div>
        </div>
        <p className="text-[11px] text-muted">
          <span className="text-ink2">Quote→USD</span>: leave <span className="text-ink2">1</span> for USD-quoted pairs (EURUSD, XAUUSD). For JPY pairs use ≈<span className="text-ink2">0.00667</span> (1/USDJPY at 150). For USDCHF ≈<span className="text-ink2">1.11</span>, USDCAD ≈<span className="text-ink2">0.74</span>. Approximate is fine — update it as spot rates drift.
        </p>
        <div>
          <label className="label">Raw data file (.txt)</label>
          {isElectron ? (
            <button type="button" className="btn-ghost w-full text-left" onClick={pickFile}>
              {filePath ? filePath.split('/').pop() : 'Choose file…'}
            </button>
          ) : (
            <input type="file" accept=".txt" className="input" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          )}
        </div>
        {progress && <div className="text-xs text-muted">Converting… {progress.rows.toLocaleString()} rows ({progress.monthKey})</div>}
        {error && <div className="text-xs text-down">{error}</div>}
        <button className="btn-primary w-full" onClick={submit} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
    </Modal>
  )
}
