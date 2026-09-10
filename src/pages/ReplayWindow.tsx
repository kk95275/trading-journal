// Pop-out window (usually on a second monitor) that shows extra charts of the
// same replay session. It creates a MirrorEngine — same data, follows the
// primary Backtest window's time cursor via BroadcastChannel — and hosts a 1/2/3
// multi-pane grid with independent timeframes per pane. Read-only: trades are
// placed from the main window.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSetting, setSetting } from '../db'
import { fmtDateTime, fmtUsd } from '../lib/gold'
import { MirrorEngine } from '../replay/mirrorEngine'
import type { SessionConfig } from '../replay/engine'
import { defaultSessionsConfig, type SessionsConfig } from '../replay/sessions'
import { defaultIndicatorsConfig, migrateIndicatorsConfig, type IndicatorsConfig } from '../replay/indicators'
import { openSyncChannel, REPLAY_SYNC_LOCALSTORAGE, type SyncMessage } from '../replay/syncChannel'
import ReplayChart from '../components/ReplayChart'
import { PnlText } from '../components/ui'

interface TfDef { label: string; sec: number }
const DEFAULT_TFS: TfDef[] = [
  { label: '1m', sec: 60 }, { label: '5m', sec: 300 }, { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 }, { label: '4h', sec: 14400 }, { label: '1d', sec: 86400 },
]
const MAX_PANES = 3

export default function ReplayWindow() {
  const [mirror, setMirror] = useState<MirrorEngine | null>(null)
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState('')
  const [, forceTick] = useState(0)
  const [paneTfs, setPaneTfs] = useState<number[]>([3600, 900])
  const [sessionsCfg, setSessionsCfg] = useState<SessionsConfig>(() => defaultSessionsConfig())
  const [indCfg, setIndCfg] = useState<IndicatorsConfig>(() => defaultIndicatorsConfig())
  const applyingRef = useRef(false)

  // Load user settings (shared with main window's Dexie via same origin).
  useEffect(() => {
    void getSetting<SessionsConfig | null>('sessionsConfig', null).then(c => c && setSessionsCfg(c))
    void getSetting<unknown>('indicatorsConfig', null).then(c => c && setIndCfg(migrateIndicatorsConfig(c)))
    void getSetting<number[]>('replayWindowPaneTfs', [3600, 900]).then(v => setPaneTfs(v.slice(0, MAX_PANES)))
  }, [])
  useEffect(() => { void setSetting('replayWindowPaneTfs', paneTfs) }, [paneTfs])

  // Bootstrap: read the session config the main window wrote before it called
  // window.open. Then either wait for a hello message from the primary or ask
  // for one so we get the current state right away.
  useEffect(() => {
    let cancelled = false
    let channel: BroadcastChannel | null = null
    ;(async () => {
      let cfg: SessionConfig | null = null
      try {
        const raw = localStorage.getItem(REPLAY_SYNC_LOCALSTORAGE)
        if (raw) cfg = JSON.parse(raw) as SessionConfig
      } catch {}
      if (!cfg) { setError('No active backtest session — start one in the main window first.'); return }

      let m: MirrorEngine
      try {
        m = await MirrorEngine.create(cfg)
      } catch (e: any) {
        if (!cancelled) setError(`Failed to load data: ${String(e?.message ?? e)}`)
        return
      }
      if (cancelled) return
      setMirror(m)

      channel = openSyncChannel()
      channel.addEventListener('message', async (e: MessageEvent<SyncMessage>) => {
        const msg = e.data
        if (!msg) return
        if (msg.kind === 'session-ended') { setEnded(true); return }
        if (msg.kind === 'tick' || msg.kind === 'hello') {
          // Coalesce — if apply is already running (chunk load), skip; the next
          // tick will catch us up.
          if (applyingRef.current) return
          applyingRef.current = true
          try { await m.apply(msg.snapshot) } finally { applyingRef.current = false }
        }
      })
      // Ask primary for a fresh hello (config+snapshot) in case we opened after
      // the initial broadcast fired.
      const req: SyncMessage = { kind: 'request-hello' }
      channel.postMessage(req)
    })()
    return () => {
      cancelled = true
      channel?.close()
    }
  }, [])

  useEffect(() => {
    if (!mirror) return
    return mirror.subscribe(() => forceTick(t => t + 1))
  }, [mirror])

  const setPaneTf = useCallback((i: number, sec: number) =>
    setPaneTfs(t => t.map((v, k) => k === i ? sec : v)), [])
  const addPane = () => setPaneTfs(t => t.length >= MAX_PANES ? t : [...t, t[t.length - 1] ?? 900])
  const removePane = (i: number) => setPaneTfs(t => t.length <= 1 ? t : t.filter((_, k) => k !== i))

  const allTfs = useMemo(() => DEFAULT_TFS.slice().sort((a, b) => a.sec - b.sec), [])

  // Stubbed drag handler — pop-out is read-only. The primary owns positions.
  const noopOnStopsDragged = useCallback(() => {}, [])

  if (error) {
    return <div className="flex items-center justify-center h-screen p-8 text-sm text-down">{error}</div>
  }
  if (!mirror) {
    return <div className="flex items-center justify-center h-screen text-sm text-muted">Loading replay data…</div>
  }

  const sessionPnl = mirror.sessionTrades.reduce((s, t) => s + t.pnl, 0)
  const openPnl = mirror.openPnlTotal()

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-hairline bg-surface text-sm">
        <div className="font-semibold text-ink">{mirror.config.accountName}</div>
        <div className="tab tab-on !cursor-default">{mirror.config.symbol}</div>
        <div className="text-muted text-xs">🕐 {fmtDateTime(mirror.currentBar.time)} GMT</div>
        <div className="text-xs">Balance <span className="text-ink font-medium">{fmtUsd(mirror.balance)}</span></div>
        <div className="text-xs">Session <PnlText v={sessionPnl} /></div>
        {mirror.positions.length > 0 && <div className="text-xs">Open ({mirror.positions.length}) <PnlText v={openPnl} /></div>}
        {mirror.loadingMore && <div className="text-xs text-warn">loading data…</div>}
        {ended && <div className="text-xs text-warn">session ended in main window</div>}
        <div className="flex-1" />
        <span className="text-[11px] text-muted">Mirror view · trades still placed from main window</span>
        <span className="text-[11px] text-muted">Charts:</span>
        {[1, 2, 3].map(n => (
          <button
            key={n}
            className={`tab ${paneTfs.length === n ? 'tab-on' : 'tab-off'}`}
            onClick={() => setPaneTfs(t => {
              if (n === t.length) return t
              if (n > t.length) return [...t, ...Array(n - t.length).fill(t[t.length - 1] ?? 900)]
              return t.slice(0, n)
            })}
          >
            {n}
          </button>
        ))}
      </div>

      <div className={`flex-1 min-h-0 p-2 grid gap-2 ${paneTfs.length === 1 ? 'grid-cols-1' : paneTfs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {paneTfs.map((paneTf, i) => (
          <div key={i} className="flex flex-col rounded-lg overflow-hidden border border-white/10 min-w-0 min-h-0">
            <div className="flex items-center gap-1 px-2 py-1 border-b border-hairline bg-surface/60 flex-wrap">
              {allTfs.map(t => (
                <button
                  key={t.sec}
                  className={`tab ${t.sec === paneTf ? 'tab-on' : 'tab-off'} !text-[11px] !py-0.5`}
                  onClick={() => setPaneTf(i, t.sec)}
                >{t.label}</button>
              ))}
              <div className="flex-1" />
              {paneTfs.length < MAX_PANES && i === paneTfs.length - 1 && (
                <button className="tab tab-off !text-[11px] !py-0.5" onClick={addPane}>+ chart</button>
              )}
              {paneTfs.length > 1 && (
                <button className="tab tab-off !text-[11px] !py-0.5 hover:!text-down" onClick={() => removePane(i)}>×</button>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <ReplayChart
                engine={mirror}
                tfSec={paneTf}
                sessions={sessionsCfg}
                indicators={indCfg}
                onStopsDragged={noopOnStopsDragged}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
