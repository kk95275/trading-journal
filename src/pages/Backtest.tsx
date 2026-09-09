import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSetting, setSetting } from '../db'
import type { Confirmation, Direction, Trade } from '../lib/types'
import { fmtDateTime, fmtR, fmtUsd, riskUsd } from '../lib/gold'
import { fmtPx, specFor } from '../lib/symbols'
import { useSymbolList } from '../lib/instruments'
import { isElectron } from '../lib/platform'
import { getManifest } from '../data/dataService'
import { ReplayEngine, getActiveEngine, setActiveEngine, type OpenPosition, type SessionConfig } from '../replay/engine'
import { defaultSessionsConfig, type SessionsConfig } from '../replay/sessions'
import { defaultIndicatorsConfig, migrateIndicatorsConfig, type IndicatorsConfig } from '../replay/indicators'
import ReplayChart, { type ChartHandle } from '../components/ReplayChart'
import SessionsPanel from '../components/SessionsPanel'
import IndicatorsPanel from '../components/IndicatorsPanel'
import { PnlText } from '../components/ui'
import AnalyzeButton from '../components/AnalyzeButton'

const SPEEDS = [1, 2, 4, 8, 16]

interface TfDef { label: string; sec: number }
const DEFAULT_TFS: TfDef[] = [
  { label: '1m', sec: 60 }, { label: '5m', sec: 300 }, { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 }, { label: '4h', sec: 14400 }, { label: '1d', sec: 86400 },
]

const fmtMonth = (s: number) => new Date(s * 1000).toISOString().slice(0, 7)

function parseTfLabel(s: string): TfDef | null {
  const m = s.trim().toLowerCase().match(/^(\d+)\s*(m|h|d|w)$/)
  if (!m) return null
  const n = +m[1]
  if (!n) return null
  const mult = m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : m[2] === 'd' ? 86400 : 604800
  const sec = n * mult
  if (sec < 60 || sec > 30 * 86400) return null
  return { label: `${n}${m[2]}`, sec }
}

export default function Backtest() {
  const [engine, setEngine] = useState<ReplayEngine | null>(() => getActiveEngine())
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!engine) return
    return engine.subscribe(() => setTick(t => t + 1))
  }, [engine])

  if (!engine) {
    return <SessionSetup onStart={e => { setActiveEngine(e); setEngine(e) }} />
  }
  return <Session engine={engine} onEnd={() => { setActiveEngine(null); setEngine(null) }} />
}

/* ---------------- session setup ---------------- */

function SessionSetup({ onStart }: { onStart: (e: ReplayEngine) => void }) {
  const accounts = useLiveQuery(() => db.accounts.where('kind').equals('backtest').toArray(), [], [])
  const SYMBOL_LIST = useSymbolList()
  const [accountId, setAccountId] = useState<number | 'new'>('new')
  const [newName, setNewName] = useState('Backtest 1')
  const [symbol, setSymbol] = useState('XAUUSD')
  const [date, setDate] = useState('2018-03-05')
  const [time, setTime] = useState('08:00')
  const [spread, setSpread] = useState(0.3)
  const [commission, setCommission] = useState(6)
  const [balance, setBalance] = useState(10000)
  const [ranges, setRanges] = useState<Record<string, { from: number; to: number }>>({})
  const [spreadBySymbol, setSpreadBySymbol] = useState<Record<string, number>>({})
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // detect which symbols have converted data — re-runs whenever the instrument list
    // changes (e.g. right after importing one in Settings) so it's selectable immediately.
    void Promise.allSettled(SYMBOL_LIST.map(s => getManifest(s).then(m => [s, { from: m.from, to: m.to }] as const))).then(results => {
      const r: Record<string, { from: number; to: number }> = {}
      for (const res of results) if (res.status === 'fulfilled') r[res.value[0]] = res.value[1]
      setRanges(r)
      if (!Object.keys(r).length) {
        setError(isElectron ? 'No chart data yet — add an instrument in Settings → Instruments' : 'No chart data found — run: npm run convert-data')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SYMBOL_LIST])

  useEffect(() => {
    void getSetting('sessionDefaults', null).then((d: any) => {
      if (!d) return
      setCommission(d.commission ?? 6)
      setBalance(d.balance ?? 10000)
      const sbs = d.spreadBySymbol ?? (d.spread !== undefined ? { XAUUSD: d.spread } : {})
      setSpreadBySymbol(sbs)
      const sym = d.lastSymbol && SYMBOL_LIST.includes(d.lastSymbol) ? d.lastSymbol : (SYMBOL_LIST[0] ?? 'XAUUSD')
      setSymbol(sym)
      setSpread(sbs[sym] ?? specFor(sym).defaultSpread)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickSymbol = (s: string) => {
    setSymbol(s)
    setSpread(spreadBySymbol[s] ?? specFor(s).defaultSpread)
  }
  const range = ranges[symbol] ?? null

  useEffect(() => {
    if (accounts && accounts.length && accountId === 'new' && newName === 'Backtest 1') {
      setAccountId(accounts[accounts.length - 1].id!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts])

  const randomDate = () => {
    if (!range) return
    const min = Math.max(range.from, Date.UTC(2006, 0, 1) / 1000)
    const max = range.to - 90 * 86400
    const ts = min + Math.random() * (max - min)
    const d = new Date(ts * 1000)
    setDate(d.toISOString().slice(0, 10))
    setTime('08:00')
  }

  const start = async () => {
    setError('')
    setStarting(true)
    try {
      let accId: number
      let accName: string
      if (accountId === 'new') {
        accName = newName.trim() || 'Backtest'
        accId = (await db.accounts.add({ name: accName, kind: 'backtest', startingBalance: balance, createdAt: Date.now() })) as number
      } else {
        accId = accountId
        accName = accounts?.find(a => a.id === accId)?.name ?? 'Backtest'
      }
      const startTs = Date.parse(`${date}T${time || '08:00'}:00Z`) / 1000
      if (range && (startTs < range.from || startTs > range.to)) {
        throw new Error(`Start date is outside the data range (${fmtMonth(range.from)} → ${fmtMonth(range.to)}).`)
      }
      const config: SessionConfig = { accountId: accId, accountName: accName, symbol, startTs, spread, commissionPerLot: commission, startingBalance: balance }
      await setSetting('sessionDefaults', {
        lastSymbol: symbol,
        spreadBySymbol: { ...spreadBySymbol, [symbol]: spread },
        commission,
        balance,
      })
      const eng = await ReplayEngine.create(config)
      onStart(eng)
    } catch (e: any) {
      setError(String(e.message || e))
      setStarting(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="card w-full max-w-md">
        <h1 className="text-lg font-semibold text-ink mb-1">New backtest session</h1>
        <p className="text-xs text-muted mb-4">1-min data · {range ? `${fmtMonth(range.from)} → ${fmtMonth(range.to)}` : '—'} · GMT · bid prices</p>
        <div className="space-y-3">
          <div>
            <label className="label">Instrument</label>
            <div className="flex gap-1.5">
              {SYMBOL_LIST.map(s => (
                <button
                  key={s}
                  className={`tab flex-1 !py-2 ${s === symbol ? 'tab-on' : 'tab-off'} ${!ranges[s] ? 'opacity-40' : ''}`}
                  disabled={!ranges[s]}
                  title={ranges[s] ? specFor(s).name : `${s}: no data converted`}
                  onClick={() => pickSymbol(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Backtest account</label>
            <select className="input" value={String(accountId)} onChange={e => setAccountId(e.target.value === 'new' ? 'new' : +e.target.value)}>
              {accounts?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value="new">+ New account…</option>
            </select>
            {accountId === 'new' && (
              <input className="input mt-2" placeholder="Account name (e.g. Strategy A backtest)" value={newName} onChange={e => setNewName(e.target.value)} />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Start date (GMT)</label>
              <input type="date" className="input" value={date} min="2003-05-06" max="2026-03-31" onChange={e => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Start time (GMT)</label>
              <input type="time" className="input" value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>
          <button className="btn-ghost w-full" onClick={randomDate}>🎲 Random date (so you can't remember the move)</button>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Spread</label>
              <input type="number" step={specFor(symbol).inputStep} min="0" className="input" value={spread} onChange={e => setSpread(+e.target.value)} />
            </div>
            <div>
              <label className="label">Commission /lot</label>
              <input type="number" step="0.5" min="0" className="input" value={commission} onChange={e => setCommission(+e.target.value)} />
            </div>
            <div>
              <label className="label">Balance ($)</label>
              <input type="number" step="100" min="1" className="input" value={balance} onChange={e => setBalance(+e.target.value)} />
            </div>
          </div>
          {error && <div className="text-xs text-down">{error}</div>}
          <button className="btn-primary w-full py-2.5" disabled={starting || !range} onClick={start}>
            {starting ? 'Loading data…' : 'Start session'}
          </button>
          <p className="text-[11px] text-muted">Data is bid-priced: buys fill at bid + spread. If SL and TP are hit inside the same 1-min bar, SL wins (conservative).</p>
        </div>
      </div>
    </div>
  )
}

/* ---------------- live session ---------------- */

function Session({ engine, onEnd }: { engine: ReplayEngine; onEnd: () => void }) {
  const [tfSec, setTfSec] = useState(900)
  const [customTfs, setCustomTfs] = useState<TfDef[]>([])
  const [tfInput, setTfInput] = useState('')
  const [showTfAdd, setShowTfAdd] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [sessionsCfg, setSessionsCfg] = useState<SessionsConfig>(() => defaultSessionsConfig())
  const [showSessions, setShowSessions] = useState(false)
  const [indCfg, setIndCfg] = useState<IndicatorsConfig>(() => defaultIndicatorsConfig())
  const [showInd, setShowInd] = useState(false)
  const chartRef = useRef<ChartHandle>(null)

  useEffect(() => {
    void getSetting<SessionsConfig | null>('sessionsConfig', null).then(c => c && setSessionsCfg(c))
    void getSetting<TfDef[]>('customTfs', []).then(setCustomTfs)
    void getSetting<unknown>('indicatorsConfig', null).then(c => c && setIndCfg(migrateIndicatorsConfig(c)))
  }, [])

  const updateIndCfg = useCallback((c: IndicatorsConfig) => {
    setIndCfg(c)
    void setSetting('indicatorsConfig', c)
  }, [])

  const allTfs = [...DEFAULT_TFS, ...customTfs].sort((a, b) => a.sec - b.sec)

  const addCustomTf = () => {
    const def = parseTfLabel(tfInput)
    if (!def) return
    setTfInput('')
    setShowTfAdd(false)
    if (allTfs.some(t => t.sec === def.sec)) { setTfSec(def.sec); return }
    const next = [...customTfs, def].sort((a, b) => a.sec - b.sec)
    setCustomTfs(next)
    void setSetting('customTfs', next)
    setTfSec(def.sec)
  }

  const removeCustomTf = (sec: number) => {
    const next = customTfs.filter(t => t.sec !== sec)
    setCustomTfs(next)
    void setSetting('customTfs', next)
    if (tfSec === sec) setTfSec(900)
  }

  const updateSessionsCfg = useCallback((c: SessionsConfig) => {
    setSessionsCfg(c)
    void setSetting('sessionsConfig', c)
  }, [])

  // persist every closed trade, with a chart snapshot
  useEffect(() => {
    engine.onTradeClosed = (trade: Trade) => {
      setTimeout(async () => {
        const shot = await chartRef.current?.screenshot()
        await db.trades.add({ ...trade, screenshot: shot ?? undefined })
      }, 150)
    }
    return () => { engine.onTradeClosed = null }
  }, [engine])

  // playback loop
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      if (!engine.step(tfSec)) setPlaying(false)
    }, Math.max(40, 1000 / speed))
    return () => clearInterval(id)
  }, [playing, speed, tfSec, engine])

  // hotkeys: → step · space play/pause · ↑/↓ speed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'ArrowRight') { e.preventDefault(); engine.step(tfSec) }
      else if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p) }
      else if (e.code === 'ArrowUp') { e.preventDefault(); setSpeed(s => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]) }
      else if (e.code === 'ArrowDown') { e.preventDefault(); setSpeed(s => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, tfSec])

  const onStopsDragged = useCallback((posId: number, sl?: number, tp?: number) => engine.modifyStops(posId, sl, tp), [engine])

  const sessionPnl = engine.sessionTrades.reduce((s, t) => s + t.pnl, 0)
  const openPnl = engine.openPnlTotal()

  return (
    <div className="flex flex-col h-full">
      {/* top bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-hairline bg-surface text-sm">
        <div className="font-semibold text-ink">{engine.config.accountName}</div>
        <div className="tab tab-on !cursor-default">{engine.config.symbol}</div>
        <div className="text-muted text-xs">🕐 {fmtDateTime(engine.currentBar.time)} GMT</div>
        <div className="text-xs">Balance <span className="text-ink font-medium">{fmtUsd(engine.balance)}</span></div>
        <div className="text-xs">Session <PnlText v={sessionPnl} /></div>
        {engine.positions.length > 0 && <div className="text-xs">Open ({engine.positions.length}) <PnlText v={openPnl} /></div>}
        {engine.loadingMore && <div className="text-xs text-warn">loading data…</div>}
        {engine.ended && <div className="text-xs text-warn">end of data</div>}
        <div className="flex-1" />
        <button className="btn-ghost text-xs" onClick={() => { setPlaying(false); onEnd() }}>End session</button>
      </div>

      {/* controls */}
      <div className="relative flex items-center gap-2 px-4 py-2 border-b border-hairline bg-surface/60">
        <div className="flex gap-1 items-center flex-wrap">
          {allTfs.map(t => {
            const custom = !DEFAULT_TFS.some(d => d.sec === t.sec)
            return (
              <button key={t.sec} className={`tab ${t.sec === tfSec ? 'tab-on' : 'tab-off'} inline-flex items-center gap-1`} onClick={() => setTfSec(t.sec)}>
                {t.label}
                {custom && (
                  <span
                    className="opacity-50 hover:opacity-100 hover:text-down"
                    title="Remove timeframe"
                    onClick={e => { e.stopPropagation(); removeCustomTf(t.sec) }}
                  >
                    ×
                  </span>
                )}
              </button>
            )
          })}
          <div className="relative">
            <button className="tab tab-off" title="Add custom timeframe" onClick={() => setShowTfAdd(v => !v)}>+</button>
            {showTfAdd && (
              <div className="absolute left-0 top-full mt-1 z-30 card !p-2 flex items-center gap-1.5 shadow-xl">
                <input
                  autoFocus
                  className="input !w-20 !py-1 text-xs"
                  placeholder="e.g. 30m"
                  value={tfInput}
                  onChange={e => setTfInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addCustomTf(); else if (e.key === 'Escape') setShowTfAdd(false) }}
                />
                <button className="btn-primary text-xs !px-2 !py-1" onClick={addCustomTf} disabled={!parseTfLabel(tfInput)}>Add</button>
              </div>
            )}
          </div>
        </div>
        <div className="w-px h-5 bg-hairline mx-1" />
        <button className="btn-ghost text-xs px-2.5" title="Step one bar (→)" onClick={() => engine.step(tfSec)}>⏭ Step</button>
        <button className={`${playing ? 'btn-primary' : 'btn-ghost'} text-xs px-2.5`} title="Play/pause (space)" onClick={() => setPlaying(p => !p)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <select className="input !w-auto !py-1 text-xs" value={speed} onChange={e => setSpeed(+e.target.value)}>
          {SPEEDS.map(s => <option key={s} value={s}>{s} bars/s</option>)}
        </select>
        <div className="w-px h-5 bg-hairline mx-1" />
        <button
          className={`tab ${indCfg.showVolume ? 'tab-on' : 'tab-off'}`}
          title="Show/hide the volume histogram"
          onClick={() => updateIndCfg({ ...indCfg, showVolume: !indCfg.showVolume })}
        >
          Vol
        </button>
        <button
          className="btn-ghost text-xs px-2.5"
          onClick={() => { setShowInd(v => !v); setShowSessions(false) }}
        >
          ƒ Indicators {showInd ? '▴' : '▾'}
        </button>
        <div className="text-[11px] text-muted ml-2">space = play · → = step · ↑↓ = speed</div>
        {showInd && (
          <IndicatorsPanel
            config={indCfg}
            onChange={updateIndCfg}
            onClose={() => setShowInd(false)}
            sessionsEnabled={sessionsCfg.enabled}
            onToggleSessions={on => updateSessionsCfg({ ...sessionsCfg, enabled: on })}
            onEditSessions={() => { setShowInd(false); setShowSessions(true) }}
          />
        )}
        {showSessions && <SessionsPanel config={sessionsCfg} onChange={updateSessionsCfg} onClose={() => setShowSessions(false)} />}
      </div>

      {/* chart + side panel */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 p-2">
          <div className="w-full h-full rounded-lg overflow-hidden border border-white/10">
            <ReplayChart ref={chartRef} engine={engine} tfSec={tfSec} sessions={sessionsCfg} indicators={indCfg} onStopsDragged={onStopsDragged} />
          </div>
        </div>
        <div className="w-80 shrink-0 border-l border-hairline overflow-y-auto p-3 space-y-3">
          {engine.positions.map(p => <PositionPanel key={p.id} engine={engine} pos={p} />)}
          <OrderTicket engine={engine} />
          <SessionTrades engine={engine} />
        </div>
      </div>
    </div>
  )
}

/* ---------------- order ticket ---------------- */

function OrderTicket({ engine }: { engine: ReplayEngine }) {
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])
  const [lots, setLots] = useState(0.1)
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const [setupId, setSetupId] = useState<number | ''>('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const symbol = engine.config.symbol
  const spec = specFor(symbol)

  useEffect(() => { void getSetting('defaultLots', 0.1).then(setLots) }, [])

  const setup = useMemo(() => setups?.find(s => s.id === setupId), [setups, setupId])
  const price = engine.bid
  const slNum = sl === '' ? undefined : +sl
  const tpNum = tp === '' ? undefined : +tp

  const setTpAtR = (r: number, dir: Direction) => {
    if (slNum === undefined) return
    const entry = dir === 'long' ? engine.ask : engine.bid
    const dist = Math.abs(entry - slNum)
    setTp((dir === 'long' ? entry + dist * r : entry - dist * r).toFixed(spec.decimals))
  }

  const place = (direction: Direction) => {
    setError('')
    const entry = direction === 'long' ? engine.ask : engine.bid
    if (!(lots > 0)) return setError('Lots must be > 0')
    if (slNum !== undefined && (direction === 'long' ? slNum >= entry : slNum <= entry)) return setError('SL must be on the losing side of entry')
    if (tpNum !== undefined && (direction === 'long' ? tpNum <= entry : tpNum >= entry)) return setError('TP must be on the winning side of entry')
    const confirmations: Confirmation[] = (setup?.criteria ?? []).map(label => ({ label, checked: !!checked[label] }))
    engine.placeMarketOrder({ direction, lots, sl: slNum, tp: tpNum, setupId: setupId || undefined, confirmations, notes })
    void setSetting('defaultLots', lots)
    setNotes(''); setChecked({}); setSl(''); setTp('')
  }

  const risk = (dir: Direction) => (slNum !== undefined ? riskUsd(dir, dir === 'long' ? engine.ask : engine.bid, slNum, lots, symbol) : undefined)

  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink">New trade</h3>
        <div className="text-xs text-muted">bid {fmtPx(price, symbol)} · ask {fmtPx(engine.ask, symbol)}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label">Lots</label>
          <input type="number" step="0.01" min="0.01" className="input" value={lots} onChange={e => setLots(+e.target.value)} />
        </div>
        <div>
          <label className="label">Stop loss</label>
          <input type="number" step={spec.inputStep} className="input" placeholder="price" value={sl} onChange={e => setSl(e.target.value)} />
        </div>
        <div>
          <label className="label">Take profit</label>
          <input type="number" step={spec.inputStep} className="input" placeholder="price" value={tp} onChange={e => setTp(e.target.value)} />
        </div>
      </div>
      {slNum !== undefined && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          TP at:
          {[1, 2, 3, 5].map(r => (
            <button key={r} className="tab tab-off" onClick={() => setTpAtR(r, slNum < price ? 'long' : 'short')}>{r}R</button>
          ))}
          <span className="ml-auto">risk ≈ {fmtUsd(risk(slNum < price ? 'long' : 'short') ?? 0, 0)}</span>
        </div>
      )}
      <div>
        <label className="label">Setup (from Playbook)</label>
        <select className="input" value={String(setupId)} onChange={e => { setSetupId(e.target.value ? +e.target.value : ''); setChecked({}) }}>
          <option value="">— none —</option>
          {setups?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {setup && setup.criteria.length > 0 && (
        <div className="space-y-1.5">
          <label className="label">Confirmations</label>
          {setup.criteria.map(c => (
            <label key={c} className="flex items-start gap-2 text-xs text-ink2 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-[#3987e5]" checked={!!checked[c]} onChange={e => setChecked(p => ({ ...p, [c]: e.target.checked }))} />
              {c}
            </label>
          ))}
          <div className="text-[11px] text-muted">
            {Object.values(checked).filter(Boolean).length}/{setup.criteria.length} confirmed
          </div>
        </div>
      )}
      <div>
        <label className="label">Entry notes / reasoning</label>
        <textarea className="input min-h-[64px]" placeholder="Why are you taking this trade?" value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      {error && <div className="text-xs text-down">{error}</div>}
      <div className="grid grid-cols-2 gap-2">
        <button className="btn-up py-2.5 font-semibold" onClick={() => place('long')}>▲ BUY</button>
        <button className="btn-down py-2.5 font-semibold" onClick={() => place('short')}>▼ SELL</button>
      </div>
    </div>
  )
}

/* ---------------- open position ---------------- */

function PositionPanel({ engine, pos }: { engine: ReplayEngine; pos: OpenPosition }) {
  const symbol = engine.config.symbol
  const spec = specFor(symbol)
  const [sl, setSl] = useState(pos.sl?.toFixed(spec.decimals) ?? '')
  const [tp, setTp] = useState(pos.tp?.toFixed(spec.decimals) ?? '')
  const [notes, setNotes] = useState(pos.notes)

  // reflect drags done on the chart
  useEffect(() => { setSl(pos.sl?.toFixed(spec.decimals) ?? ''); setTp(pos.tp?.toFixed(spec.decimals) ?? '') }, [pos.sl, pos.tp, spec.decimals])

  const openPnl = engine.openPnl(pos)
  const risk = pos.sl !== undefined ? riskUsd(pos.direction, pos.entryPrice, pos.sl, pos.lots, symbol) : undefined
  const openR = risk && risk > 0 ? openPnl / risk : undefined

  const commit = () => {
    engine.modifyStops(pos.id, sl === '' ? undefined : +sl, tp === '' ? undefined : +tp)
    engine.updateNotes(pos.id, notes)
  }

  return (
    <div className="card space-y-3 border-accent/30">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          <span className={pos.direction === 'long' ? 'text-up' : 'text-down'}>{pos.direction === 'long' ? '▲ LONG' : '▼ SHORT'}</span>
          {' '}{pos.lots} lots <span className="text-muted font-normal text-xs">#{pos.id}</span>
        </h3>
        <div className="text-lg font-semibold"><PnlText v={openPnl} /></div>
      </div>
      <div className="text-xs text-muted space-y-0.5">
        <div>Entry {fmtPx(pos.entryPrice, symbol)} @ {fmtDateTime(pos.entryTime)} GMT</div>
        <div>Now bid {fmtPx(engine.bid, symbol)} {openR !== undefined && <>· {fmtR(openR)}</>} {risk !== undefined && <>· risk {fmtUsd(risk, 0)}</>}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Stop loss (drag on chart)</label>
          <input type="number" step={spec.inputStep} className="input" value={sl} onChange={e => setSl(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
        </div>
        <div>
          <label className="label">Take profit</label>
          <input type="number" step={spec.inputStep} className="input" value={tp} onChange={e => setTp(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
        </div>
      </div>
      <div>
        <label className="label">Trade notes</label>
        <textarea className="input min-h-[64px]" value={notes} onChange={e => { setNotes(e.target.value); engine.updateNotes(pos.id, e.target.value) }} />
      </div>
      <button className="btn-ghost w-full" onClick={() => engine.closeManual(pos.id)}>Close position at market</button>
    </div>
  )
}

/* ---------------- session trades ---------------- */

function SessionTrades({ engine }: { engine: ReplayEngine }) {
  const trades = engine.sessionTrades
  if (!trades.length) return <div className="card text-xs text-muted text-center py-4">No trades this session yet.</div>
  return (
    <div className="card !p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-hairline flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-ink">Session trades ({trades.length})</div>
        <AnalyzeButton trades={trades} scope={`backtest session (${trades.length} trades)`} className="btn-ghost text-[11px] !py-0.5" label="Analyze" />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {[...trades].reverse().map((t, i) => (
          <div key={i} className="px-3 py-2 border-b border-grid text-xs flex items-center gap-2">
            <span className={t.direction === 'long' ? 'text-up' : 'text-down'}>{t.direction === 'long' ? '▲' : '▼'}</span>
            <span className="text-muted">{fmtDateTime(t.entryTime).slice(5)}</span>
            <span>{fmtPx(t.entryPrice, t.symbol)}→{fmtPx(t.exitPrice, t.symbol)}</span>
            <span className="text-muted uppercase text-[10px]">{t.exitReason}</span>
            <span className="ml-auto"><PnlText v={t.pnl} digits={0} /></span>
            <span className="text-muted w-12 text-right">{fmtR(t.rMultiple)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
