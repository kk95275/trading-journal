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
import IndicatorsPanel from '../components/IndicatorsPanel'
import { PnlText } from '../components/ui'

interface TfDef { label: string; sec: number }
const DEFAULT_TFS: TfDef[] = [
  { label: '1m', sec: 60 }, { label: '5m', sec: 300 }, { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 }, { label: '4h', sec: 14400 }, { label: '1d', sec: 86400 },
]
const MAX_PANES = 3

interface PaneConfig {
  tfSec: number
  indCfg: IndicatorsConfig
}

export default function ReplayWindow() {
  const [mirror, setMirror] = useState<MirrorEngine | null>(null)
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState('')
  const [, forceTick] = useState(0)
  const [panes, setPanes] = useState<PaneConfig[]>([
    { tfSec: 3600, indCfg: defaultIndicatorsConfig() },
    { tfSec: 900, indCfg: defaultIndicatorsConfig() },
  ])
  const [sessionsCfg, setSessionsCfg] = useState<SessionsConfig>(() => defaultSessionsConfig())
  const [openIndPane, setOpenIndPane] = useState<number | null>(null)
  const applyingRef = useRef(false)

  // Load user settings (shared with main window's Dexie via same origin).
  useEffect(() => {
    void getSetting<SessionsConfig | null>('sessionsConfig', null).then(c => c && setSessionsCfg(c))
    ;(async () => {
      const stored = await getSetting<PaneConfig[] | null>('replayWindowPanes', null)
      if (stored && stored.length > 0) {
        setPanes(stored.slice(0, MAX_PANES).map(p => ({
          tfSec: p.tfSec ?? 900,
          indCfg: migrateIndicatorsConfig(p.indCfg),
        })))
        return
      }
      // Migrate from the pre-1.5.1 flat-timeframe key.
      const [oldTfs, sharedInd] = await Promise.all([
        getSetting<number[]>('replayWindowPaneTfs', [3600, 900]),
        getSetting<unknown>('indicatorsConfig', null),
      ])
      const seed = sharedInd ? migrateIndicatorsConfig(sharedInd) : defaultIndicatorsConfig()
      setPanes(oldTfs.slice(0, MAX_PANES).map(t => ({ tfSec: t, indCfg: seed })))
    })()
  }, [])
  useEffect(() => { void setSetting('replayWindowPanes', panes) }, [panes])

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
    setPanes(p => p.map((v, k) => k === i ? { ...v, tfSec: sec } : v)), [])
  const setPaneIndCfg = useCallback((i: number, indCfg: IndicatorsConfig) =>
    setPanes(p => p.map((v, k) => k === i ? { ...v, indCfg } : v)), [])
  const addPane = () => setPanes(p => {
    if (p.length >= MAX_PANES) return p
    const last = p[p.length - 1]
    return [...p, { tfSec: last?.tfSec ?? 900, indCfg: last?.indCfg ?? defaultIndicatorsConfig() }]
  })
  const removePane = (i: number) => setPanes(p => p.length <= 1 ? p : p.filter((_, k) => k !== i))

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
            className={`tab ${panes.length === n ? 'tab-on' : 'tab-off'}`}
            onClick={() => setPanes(p => {
              if (n === p.length) return p
              if (n > p.length) {
                const seed = p[p.length - 1] ?? { tfSec: 900, indCfg: defaultIndicatorsConfig() }
                return [...p, ...Array(n - p.length).fill(0).map(() => ({ tfSec: seed.tfSec, indCfg: seed.indCfg }))]
              }
              return p.slice(0, n)
            })}
          >
            {n}
          </button>
        ))}
      </div>

      <div className={`flex-1 min-h-0 p-2 grid gap-2 ${panes.length === 1 ? 'grid-cols-1' : panes.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {panes.map((pane, i) => (
          <div key={i} className="flex flex-col rounded-lg overflow-hidden border border-white/10 min-w-0 min-h-0">
            <div className="relative flex items-center gap-1 px-2 py-1 border-b border-hairline bg-surface/60 flex-wrap">
              {allTfs.map(t => (
                <button
                  key={t.sec}
                  className={`tab ${t.sec === pane.tfSec ? 'tab-on' : 'tab-off'} !text-[11px] !py-0.5`}
                  onClick={() => setPaneTf(i, t.sec)}
                >{t.label}</button>
              ))}
              <div className="flex-1" />
              <button
                className={`tab ${pane.indCfg.showVolume ? 'tab-on' : 'tab-off'} !text-[11px] !py-0.5`}
                title="Show/hide volume on this chart"
                onClick={() => setPaneIndCfg(i, { ...pane.indCfg, showVolume: !pane.indCfg.showVolume })}
              >Vol</button>
              <button
                className={`tab ${openIndPane === i ? 'tab-on' : 'tab-off'} !text-[11px] !py-0.5`}
                title="Indicators for this chart"
                onClick={() => setOpenIndPane(v => v === i ? null : i)}
              >ƒ {pane.indCfg.active.length > 0 && <span className="text-accent">·{pane.indCfg.active.length}</span>}</button>
              {panes.length < MAX_PANES && i === panes.length - 1 && (
                <button className="tab tab-off !text-[11px] !py-0.5" onClick={addPane}>+ chart</button>
              )}
              {panes.length > 1 && (
                <button className="tab tab-off !text-[11px] !py-0.5 hover:!text-down" onClick={() => removePane(i)}>×</button>
              )}
              {openIndPane === i && (
                <IndicatorsPanel
                  config={pane.indCfg}
                  onChange={c => setPaneIndCfg(i, c)}
                  onClose={() => setOpenIndPane(null)}
                  sessionsEnabled={sessionsCfg.enabled}
                  onToggleSessions={on => setSessionsCfg({ ...sessionsCfg, enabled: on })}
                  onEditSessions={() => setOpenIndPane(null)}
                />
              )}
            </div>
            <div className="flex-1 min-h-0">
              <ReplayChart
                engine={mirror}
                tfSec={pane.tfSec}
                sessions={sessionsCfg}
                indicators={pane.indCfg}
                onStopsDragged={noopOnStopsDragged}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
