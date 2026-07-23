// Indicators menu with side tabs: Standard (built-ins, add-flow with settings →
// Add/Cancel) and Custom (our own indicators, e.g. Sessions).
import { useState } from 'react'
import {
  INDICATOR_COLORS, indicatorLabel,
  type ActiveIndicator, type IndicatorKind, type IndicatorsConfig,
} from '../replay/indicators'

interface Props {
  config: IndicatorsConfig
  onChange: (c: IndicatorsConfig) => void
  onClose: () => void
  sessionsEnabled: boolean
  onToggleSessions: (on: boolean) => void
  onEditSessions: () => void
}

const CATALOG: { kind: IndicatorKind; name: string; desc: string }[] = [
  { kind: 'ma', name: 'Moving Average', desc: 'SMA or EMA, any length' },
  { kind: 'bb', name: 'Bollinger Bands', desc: 'basis ± σ bands' },
  { kind: 'vwap', name: 'VWAP', desc: 'daily anchored (GMT)' },
  { kind: 'rsi', name: 'RSI', desc: 'oscillator pane below chart' },
  { kind: 'macd', name: 'MACD', desc: 'oscillator pane below chart' },
]

function newDraft(kind: IndicatorKind, existing?: ActiveIndicator): ActiveIndicator {
  if (existing) return { ...existing }
  const base = { id: `i${Date.now() % 1e8}`, kind, color: INDICATOR_COLORS[0] }
  switch (kind) {
    case 'ma': return { ...base, maType: 'ema', length: 20 }
    case 'bb': return { ...base, length: 20, mult: 2, color: '#9085e9' }
    case 'vwap': return { ...base, color: '#e87ba4' }
    case 'rsi': return { ...base, length: 14, color: '#9085e9' }
    case 'macd': return { ...base, fast: 12, slow: 26, signal: 9 }
  }
}

function ColorDots({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex gap-0.5">
      {INDICATOR_COLORS.map(c => (
        <button
          key={c}
          className={`w-4 h-4 rounded-full border ${value === c ? 'border-white' : 'border-transparent'}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

function Num({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted">
      {label}
      <input
        type="number" min={min} max={max} step={step ?? 1}
        className="input !w-16 !py-1 text-xs"
        value={value}
        onChange={e => onChange(Math.max(min, Math.min(max, +e.target.value || min)))}
      />
    </label>
  )
}

export default function IndicatorsPanel({ config, onChange, onClose, sessionsEnabled, onToggleSessions, onEditSessions }: Props) {
  const [tab, setTab] = useState<'standard' | 'custom'>('standard')
  const [draft, setDraft] = useState<ActiveIndicator | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const upd = (patch: Partial<ActiveIndicator>) => setDraft(d => d && { ...d, ...patch })

  const commitDraft = () => {
    if (!draft) return
    const active = editingId
      ? config.active.map(a => (a.id === editingId ? draft : a))
      : [...config.active, draft]
    onChange({ ...config, active })
    setDraft(null)
    setEditingId(null)
  }

  const cancelDraft = () => { setDraft(null); setEditingId(null) }

  return (
    <div className="absolute left-4 top-full mt-1 z-30 w-[520px] card !p-0 shadow-2xl border-white/20 max-h-[70vh] overflow-hidden flex">
      {/* side tabs */}
      <div className="w-24 shrink-0 border-r border-hairline p-1.5 space-y-1">
        {(['standard', 'custom'] as const).map(t => (
          <button
            key={t}
            className={`w-full text-left px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === t ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/5'
            }`}
            onClick={() => { setTab(t); cancelDraft() }}
          >
            {t === 'standard' ? 'Standard' : 'Custom'}
          </button>
        ))}
      </div>

      {/* content */}
      <div className="flex-1 p-4 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-ink">{tab === 'standard' ? 'Standard indicators' : 'Custom indicators'}</h3>
          <button className="text-muted hover:text-ink text-lg leading-none" onClick={onClose}>×</button>
        </div>

        {tab === 'standard' && (
          <>
            <label className="flex items-center gap-2 text-xs text-ink2 cursor-pointer mb-3">
              <input type="checkbox" className="accent-[#3987e5]" checked={config.showVolume} onChange={e => onChange({ ...config, showVolume: e.target.checked })} />
              Volume histogram (bottom of chart)
            </label>

            {config.active.length > 0 && (
              <div className="mb-3">
                <div className="text-[11px] text-muted mb-1.5">On chart</div>
                <div className="space-y-1">
                  {config.active.map(a => (
                    <div key={a.id} className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-2.5 py-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
                      <span className="text-xs text-ink">{indicatorLabel(a)}</span>
                      <button
                        className="btn-ghost !px-2 !py-0.5 text-[11px] ml-auto"
                        onClick={() => { setDraft(newDraft(a.kind, a)); setEditingId(a.id) }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-muted hover:text-down text-sm"
                        title="Remove"
                        onClick={() => { onChange({ ...config, active: config.active.filter(x => x.id !== a.id) }); if (editingId === a.id) cancelDraft() }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {draft ? (
              <div className="border border-accent/40 rounded-lg p-3 space-y-3">
                <div className="text-xs font-semibold text-ink">
                  {editingId ? 'Edit' : 'Add'} {CATALOG.find(c => c.kind === draft.kind)?.name}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {draft.kind === 'ma' && (
                    <>
                      <select className="input !w-auto !py-1 text-xs" value={draft.maType ?? 'ema'} onChange={e => upd({ maType: e.target.value as 'sma' | 'ema' })}>
                        <option value="ema">EMA</option>
                        <option value="sma">SMA</option>
                      </select>
                      <Num label="length" value={draft.length ?? 20} min={1} max={1000} onChange={v => upd({ length: v })} />
                    </>
                  )}
                  {draft.kind === 'bb' && (
                    <>
                      <Num label="length" value={draft.length ?? 20} min={2} max={500} onChange={v => upd({ length: v })} />
                      <Num label="σ" value={draft.mult ?? 2} min={0.5} max={5} step={0.5} onChange={v => upd({ mult: v })} />
                    </>
                  )}
                  {draft.kind === 'rsi' && <Num label="length" value={draft.length ?? 14} min={2} max={200} onChange={v => upd({ length: v })} />}
                  {draft.kind === 'macd' && (
                    <>
                      <Num label="fast" value={draft.fast ?? 12} min={1} max={200} onChange={v => upd({ fast: v })} />
                      <Num label="slow" value={draft.slow ?? 26} min={2} max={400} onChange={v => upd({ slow: v })} />
                      <Num label="signal" value={draft.signal ?? 9} min={1} max={100} onChange={v => upd({ signal: v })} />
                    </>
                  )}
                  {draft.kind === 'vwap' && <span className="text-[11px] text-muted">Anchored to each GMT day.</span>}
                  <ColorDots value={draft.color} onPick={c => upd({ color: c })} />
                </div>
                <div className="flex gap-2 justify-end">
                  <button className="btn-ghost text-xs" onClick={cancelDraft}>Cancel</button>
                  <button className="btn-primary text-xs" onClick={commitDraft}>{editingId ? 'Save' : 'Add to chart'}</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-[11px] text-muted mb-1.5">Add indicator</div>
                <div className="space-y-1">
                  {CATALOG.map(c => (
                    <button
                      key={c.kind}
                      className="w-full flex items-baseline gap-2 text-left px-2.5 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                      onClick={() => { setDraft(newDraft(c.kind)); setEditingId(null) }}
                    >
                      <span className="text-xs text-ink font-medium">{c.name}</span>
                      <span className="text-[11px] text-muted">{c.desc}</span>
                      <span className="ml-auto text-muted text-xs">+</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'custom' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-2.5 py-2">
              <input type="checkbox" className="accent-[#3987e5]" checked={sessionsEnabled} onChange={e => onToggleSessions(e.target.checked)} />
              <div>
                <div className="text-xs text-ink font-medium">⏱ Sessions</div>
                <div className="text-[11px] text-muted">killzones & session high/low bands</div>
              </div>
              <button className="btn-ghost text-xs ml-auto" onClick={onEditSessions}>Edit…</button>
            </div>
            <p className="text-[11px] text-muted">Ported Pine Script indicators land here. Send me the next script to add it.</p>
          </div>
        )}
      </div>
    </div>
  )
}
