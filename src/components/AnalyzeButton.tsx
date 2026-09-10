import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { Trade } from '../lib/types'
import { streamChat, PROVIDER_LABELS, type AIProvider } from '../lib/ai'
import { buildTradeContext, ANALYSIS_SYSTEM_PROMPT } from '../lib/aiContext'
import {
  EMPTY_FILTERS, applyFilters, hasActiveFilters, describeFilters,
  epochToDateInput, toEpochStartOfDay, toEpochEndOfDay,
  type TradeFilters,
} from '../lib/aiFilters'
import { DOW } from '../lib/stats'
import { loadAIConfig, modelsFor, DEFAULT_AI_CONFIG, type AIConfig } from './AISettingsCard'
import { Modal } from './ui'

/**
 * Reusable "Analyze with AI" button. Opens a modal, gathers the trade context
 * for the given trade slice, and streams the model's analysis back live.
 */
export default function AnalyzeButton({
  trades,
  scope,
  label = 'Analyze with AI',
  className = 'btn-primary text-xs',
}: {
  trades: Trade[]
  scope: string
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={trades.length === 0}>
        {label}
      </button>
      {open && <AnalyzeModal trades={trades} scope={scope} onClose={() => setOpen(false)} />}
    </>
  )
}

const SESSION_OPTS = ['Asian', 'London', 'New York', 'Off-hours'] as const
const EXIT_OPTS = [
  { id: 'sl', label: 'Stop loss' },
  { id: 'tp', label: 'Take profit' },
  { id: 'manual', label: 'Manual' },
  { id: 'other', label: 'Other' },
] as const
const GRADE_OPTS = ['A', 'B', 'C', 'D', 'Ungraded'] as const

function AnalyzeModal({ trades: incoming, scope, onClose }: { trades: Trade[]; scope: string; onClose: () => void }) {
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])
  const [cfg, setCfg] = useState<AIConfig>(DEFAULT_AI_CONFIG)
  const [provider, setProvider] = useState<AIProvider>('openai')
  const [model, setModel] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [contextBytes, setContextBytes] = useState<number | null>(null)
  const [filters, setFilters] = useState<TradeFilters>(EMPTY_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void loadAIConfig().then(c => {
      setCfg(c)
      setProvider(c.defaultProvider)
      setModel(c.defaultProvider === 'ollama' ? c.ollamaModel : c.defaultModel)
    })
  }, [])

  const filtered = useMemo(() => applyFilters(incoming, filters), [incoming, filters])

  // Options derived from the incoming trade slice — only show things that
  // actually appear in this view.
  const symbolOpts = useMemo(
    () => Array.from(new Set(incoming.map(t => t.symbol))).sort(),
    [incoming],
  )
  const setupOpts = useMemo(() => {
    const ids = new Set<number | 'none'>()
    for (const t of incoming) ids.add(t.setupId ?? 'none')
    const rows: { id: number | 'none'; name: string }[] = []
    for (const id of ids) {
      if (id === 'none') rows.push({ id, name: '(no setup)' })
      else {
        const s = setups.find(s => s.id === id)
        rows.push({ id, name: s?.name ?? `#${id}` })
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [incoming, setups])
  const setupNameById = useMemo(
    () => new Map(setups.map(s => [s.id!, s.name])),
    [setups],
  )

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }

  const resetFilters = () => setFilters(EMPTY_FILTERS)

  const run = async () => {
    if (filtered.length === 0) return
    setError('')
    setOutput('')
    setRunning(true)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const [allSetups, journal] = await Promise.all([db.setups.toArray(), db.journal.toArray()])
      const filterDesc = describeFilters(filters, setupNameById)
      const ctx = buildTradeContext(filtered, allSetups, journal, {
        scope: `${scope}${filterDesc}`,
      })
      setContextBytes(ctx.approxBytes)
      const messages = [
        { role: 'system' as const, content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user' as const, content: `${ctx.text}\n\nPlease analyze and give me your recommendations.` },
      ]
      let acc = ''
      await streamChat(
        { provider, model, messages, ollamaBaseUrl: cfg.ollamaBaseUrl, temperature: 0.4 },
        d => { acc += d; setOutput(acc) },
        abort.signal,
      )
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (!/abort/i.test(msg)) setError(msg)
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  return (
    <Modal title={`Analyze — ${scope}`} onClose={running ? () => { cancel(); onClose() } : onClose} wide>
      <div className="space-y-3">
        {/* Model row */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink font-medium">
            {filtered.length} <span className="text-muted">of {incoming.length} trades</span>
          </span>
          <span className="text-muted">·</span>
          <select className="input !w-auto !text-xs" value={provider} disabled={running}
            onChange={e => {
              const p = e.target.value as AIProvider
              setProvider(p)
              setModel(p === 'ollama' ? cfg.ollamaModel : (modelsFor(p, cfg)[0]?.id ?? ''))
            }}>
            {(['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'] as AIProvider[]).map(p => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
          {provider === 'ollama' ? (
            <input className="input !w-auto !text-xs" value={model}
              onChange={e => setModel(e.target.value)} disabled={running} />
          ) : (
            <select className="input !w-auto !text-xs" value={model} disabled={running}
              onChange={e => setModel(e.target.value)}>
              {modelsFor(provider, cfg).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          {contextBytes !== null && (
            <span className="text-muted">· payload ~{Math.round(contextBytes / 1024)}KB</span>
          )}
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => setShowFilters(s => !s)} disabled={running}>
              {showFilters ? '▾ Hide filters' : '▸ Filters'}
              {hasActiveFilters(filters) && <span className="ml-1 text-accent">●</span>}
            </button>
            {running
              ? <button className="btn-ghost text-xs" onClick={cancel}>Stop</button>
              : <button className="btn-primary text-xs" onClick={() => void run()} disabled={filtered.length === 0}>
                  {output ? 'Re-run analysis' : 'Run analysis'}
                </button>}
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="rounded-lg border border-hairline bg-black/20 p-3 space-y-2.5 text-xs">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="label">From (UTC)</label>
                <input type="date" className="input !text-xs" disabled={running}
                  value={epochToDateInput(filters.dateFrom)}
                  onChange={e => setFilters(f => ({ ...f, dateFrom: toEpochStartOfDay(e.target.value) }))} />
              </div>
              <div>
                <label className="label">To (UTC)</label>
                <input type="date" className="input !text-xs" disabled={running}
                  value={epochToDateInput(filters.dateTo)}
                  onChange={e => setFilters(f => ({ ...f, dateTo: toEpochEndOfDay(e.target.value) }))} />
              </div>
              <div>
                <label className="label">Direction</label>
                <select className="input !text-xs" disabled={running}
                  value={filters.direction}
                  onChange={e => setFilters(f => ({ ...f, direction: e.target.value as TradeFilters['direction'] }))}>
                  <option value="all">All</option>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </div>
              <div>
                <label className="label">Result</label>
                <select className="input !text-xs" disabled={running}
                  value={filters.result}
                  onChange={e => setFilters(f => ({ ...f, result: e.target.value as TradeFilters['result'] }))}>
                  <option value="all">All</option>
                  <option value="win">Wins only</option>
                  <option value="loss">Losses only</option>
                  <option value="breakeven">Breakeven only</option>
                </select>
              </div>
            </div>

            {symbolOpts.length > 1 && (
              <ChipRow
                label="Symbols"
                options={symbolOpts.map(s => ({ id: s, label: s }))}
                selected={filters.symbols}
                onToggle={id => setFilters(f => toggleIn(f, 'symbols', id))}
                disabled={running}
              />
            )}
            {setupOpts.length > 1 && (
              <ChipRow
                label="Setups"
                options={setupOpts.map(s => ({ id: String(s.id), label: s.name }))}
                selected={filters.setupIds.map(id => String(id))}
                onToggle={idStr => setFilters(f => {
                  const id: number | 'none' = idStr === 'none' ? 'none' : Number(idStr)
                  const has = f.setupIds.includes(id)
                  return { ...f, setupIds: has ? f.setupIds.filter(x => x !== id) : [...f.setupIds, id] }
                })}
                disabled={running}
              />
            )}
            <ChipRow
              label="Grades"
              options={GRADE_OPTS.map(g => ({ id: g, label: g }))}
              selected={filters.grades}
              onToggle={id => setFilters(f => toggleIn(f, 'grades', id))}
              disabled={running}
            />
            <ChipRow
              label="Sessions (UTC)"
              options={SESSION_OPTS.map(s => ({ id: s, label: s }))}
              selected={filters.sessions}
              onToggle={id => setFilters(f => toggleIn(f, 'sessions', id))}
              disabled={running}
            />
            <ChipRow
              label="Day of week"
              options={DOW.map(d => ({ id: d, label: d }))}
              selected={filters.daysOfWeek}
              onToggle={id => setFilters(f => toggleIn(f, 'daysOfWeek', id))}
              disabled={running}
            />
            <ChipRow
              label="Exit reason"
              options={EXIT_OPTS.map(e => ({ id: e.id, label: e.label }))}
              selected={filters.exitReasons}
              onToggle={id => setFilters(f => toggleIn(f, 'exitReasons', id))}
              disabled={running}
            />

            <div className="flex items-center justify-between pt-1">
              <span className="text-muted">
                {hasActiveFilters(filters) ? `Filtering: ${filtered.length} of ${incoming.length}` : 'No filters active'}
              </span>
              <button className="btn-ghost text-xs" onClick={resetFilters} disabled={running || !hasActiveFilters(filters)}>
                Reset filters
              </button>
            </div>
          </div>
        )}

        {error && <div className="text-xs text-down whitespace-pre-wrap">{error}</div>}

        {!output && !running && !error && (
          <div className="text-xs text-muted">
            Sends a compact summary of {filtered.length} trades (per-setup breakdown, session/hour stats,
            mistake tags, sample trades with notes) to the selected model, then streams back an analysis with
            a recommended strategy focus. Use <em>Filters</em> to narrow the slice — e.g. only A-graded London
            trades in September.
          </div>
        )}

        {(output || running) && (
          <div className="rounded-lg border border-hairline bg-black/20 p-4 text-sm text-ink2 whitespace-pre-wrap max-h-[55vh] overflow-y-auto leading-relaxed">
            {output || '…'}
          </div>
        )}
      </div>
    </Modal>
  )
}

function toggleIn<K extends 'symbols' | 'grades' | 'sessions' | 'daysOfWeek' | 'exitReasons'>(
  f: TradeFilters, key: K, id: string,
): TradeFilters {
  const cur = f[key] as string[]
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  return { ...f, [key]: next } as TradeFilters
}

function ChipRow({
  label, options, selected, onToggle, disabled,
}: {
  label: string
  options: { id: string; label: string }[]
  selected: string[]
  onToggle: (id: string) => void
  disabled?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] text-muted uppercase tracking-widest mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map(o => {
          const on = selected.includes(o.id)
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(o.id)}
              className={`px-2 py-0.5 rounded-md border text-[11px] transition-colors ${
                on ? 'border-accent/60 bg-accent/15 text-ink' : 'border-hairline text-ink2 hover:border-white/25'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
