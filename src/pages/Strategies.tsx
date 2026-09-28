// Python strategy backtester. Users write Python (via Pyodide), define
// on_bar(ctx), run against 1m historical bars for any imported instrument,
// and get equity curve + stats + hourly breakdown. "Analyze with AI" pipes
// the results through the same streamChat pipeline the journal uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Bar as BarChart, Bar as RCBar, BarChart as RCBarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Editor, { type OnMount } from '@monaco-editor/react'
import { db, getSetting, setSetting, type StrategyDef } from '../db'
import { getBars, chunksFor } from '../data/dataService'
import { fmtDate, fmtUsd, fmtR, fmtDateTime, fmtPct, fmtDuration } from '../lib/gold'
import { useSymbolList } from '../lib/instruments'
import { summarize } from '../lib/stats'
import { streamChat, PROVIDER_LABELS, type AIProvider } from '../lib/ai'
import { CHAT_SYSTEM_PROMPT } from '../lib/aiContext'
import { loadAIConfig, modelsFor, DEFAULT_AI_CONFIG, type AIConfig } from '../components/AISettingsCard'
import { Empty, PageHead, PnlText } from '../components/ui'
import { runBacktest, hourlyBreakdown, dowBreakdown, type BacktestResult, type RunProgress } from '../strategy/runner'
import { loadPyodideRuntime, onPyodideStatus, pyodideStatus, type LoadStatus } from '../strategy/pyodide'
import { STRATEGY_EXAMPLES } from '../strategy/examples'
import { lintPython, autoFix, type LintIssue } from '../strategy/lint'

const AXIS = '#898781'
const GRID = '#2c2c2a'
const UP = '#0ca30c'
const DOWN = '#d03b3b'

const TOOLTIP = {
  contentStyle: { background: '#222221', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#c3c2b7' },
  itemStyle: { color: '#ffffff' },
}

// Suppress a false-positive: recharts imports `Bar` twice above for clarity.
void BarChart; void RCBar

export default function Strategies() {
  const strategies = useLiveQuery(() => db.strategies.orderBy('updatedAt').reverse().toArray(), [], [] as StrategyDef[])
  const symbols = useSymbolList()
  const [activeId, setActiveId] = useState<number | null>(null)
  const [draft, setDraft] = useState<StrategyDef | null>(null)
  const [pyStatus, setPyStatus] = useState<LoadStatus>(pyodideStatus())
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [issues, setIssues] = useState<LintIssue[]>([])
  const [autoFixOn, setAutoFixOn] = useState(true)
  // Handles used by lint + autofix to reach into Monaco. `any` here because
  // monaco types aren't exported from the react wrapper without importing
  // 'monaco-editor' (which we lazy-load; keeping the type dep-free is fine).
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)

  const active = strategies.find(s => s.id === activeId) ?? null

  // Bring editor into sync whenever the active strategy changes.
  useEffect(() => {
    if (active) setDraft({ ...active })
    else setDraft(null)
    setResult(null)
  }, [active?.id])

  // Fall back to the most recent when nothing is selected.
  useEffect(() => {
    if (activeId == null && strategies.length > 0) setActiveId(strategies[0].id!)
  }, [strategies, activeId])

  useEffect(() => onPyodideStatus(setPyStatus), [])

  // Auto-fix on save toggle — remembered per user.
  useEffect(() => {
    void getSetting<boolean>('strategyAutoFix', true).then(setAutoFixOn)
  }, [])
  useEffect(() => { void setSetting('strategyAutoFix', autoFixOn) }, [autoFixOn])

  // Debounced live lint. Fires 400ms after typing stops. Warms pyodide the
  // first time (~10 MB download) — same runtime the backtest uses.
  useEffect(() => {
    if (!draft) { setIssues([]); return }
    const code = draft.code
    const handle = window.setTimeout(async () => {
      const found = await lintPython(code)
      setIssues(found)
      // Push markers into Monaco so squiggles appear inline.
      const editor = editorRef.current, monaco = monacoRef.current
      if (editor && monaco) {
        const model = editor.getModel()
        if (model) {
          monaco.editor.setModelMarkers(model, 'py-lint', found.map(iss => ({
            severity: iss.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            message: iss.message,
            startLineNumber: iss.line,
            startColumn: iss.column,
            endLineNumber: iss.line,
            endColumn: iss.endColumn ?? iss.column + 1,
          })))
        }
      }
    }, 400)
    return () => window.clearTimeout(handle)
  }, [draft?.code, draft?.id])

  const startNew = () => {
    const now = Date.now()
    const seed = STRATEGY_EXAMPLES[0]
    setActiveId(null)
    setDraft({
      name: 'New strategy',
      code: seed.code,
      symbol: symbols[0] ?? 'XAUUSD',
      spread: 0.3,
      commissionPerLot: 6,
      startingBalance: 10000,
      createdAt: now,
      updatedAt: now,
    })
    setResult(null)
  }

  const save = async () => {
    if (!draft) return
    // Apply auto-fix silently on save if the toggle is on. Only the whitespace
    // is touched — semantics stay identical (see autoFix() docstring).
    const nextCode = autoFixOn ? autoFix(draft.code) : draft.code
    const rec = { ...draft, code: nextCode, updatedAt: Date.now() }
    if (nextCode !== draft.code) setDraft({ ...draft, code: nextCode })
    if (rec.id !== undefined) {
      await db.strategies.update(rec.id, rec)
    } else {
      const id = await db.strategies.add({ ...rec, createdAt: Date.now() })
      setActiveId(id as number)
    }
  }

  const formatNow = () => {
    if (!draft) return
    setDraft({ ...draft, code: autoFix(draft.code) })
  }

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    // Ctrl/⌘+S formats + saves. Bypasses the browser's own save dialog.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save() })
  }, [autoFixOn, draft?.id])

  const del = async () => {
    if (!draft?.id) return
    if (!confirm(`Delete strategy "${draft.name}"?`)) return
    await db.strategies.delete(draft.id)
    setActiveId(null)
    setDraft(null)
    setResult(null)
  }

  const run = async () => {
    if (!draft || running) return
    setRunning(true)
    setResult(null)
    try {
      setProgress({ processed: 0, total: 0, message: 'Loading data…' })
      const chunks = await chunksFor(draft.symbol, '1m')
      if (!chunks.length) throw new Error(`No 1m data for ${draft.symbol}. Import it under Settings → Instruments.`)
      const from = draft.from ?? chunks[0].from
      const to = draft.to ?? chunks[chunks.length - 1].to
      const bars = await getBars(draft.symbol, '1m', from, to)
      if (!bars.length) throw new Error('No bars in the selected range.')

      // Kick off pyodide load so its status flows to the UI even before runBacktest awaits it.
      void loadPyodideRuntime()

      const r = await runBacktest(
        {
          symbol: draft.symbol,
          bars,
          spread: draft.spread,
          commissionPerLot: draft.commissionPerLot,
          startingBalance: draft.startingBalance,
        },
        draft.code,
        p => setProgress(p),
      )
      setResult(r)
    } catch (e: any) {
      setResult({
        trades: [], equity: [], finalBalance: draft.startingBalance,
        logs: [], error: String(e?.message ?? e), runtimeSeconds: 0,
      })
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <div className="pb-6">
      <PageHead
        title="Strategies"
        sub="Write algorithmic strategies in Python and backtest them against your data"
        right={<button className="btn-primary text-xs" onClick={startNew}>+ New strategy</button>}
      />
      <div className="px-6 grid grid-cols-[240px_1fr] gap-4" style={{ height: 'calc(100vh - 110px)' }}>
        {/* Sidebar */}
        <aside className="card !p-2 overflow-y-auto">
          {strategies.length === 0 ? (
            <div className="text-xs text-muted p-3">No strategies yet. Click <span className="text-ink2">+ New strategy</span>.</div>
          ) : strategies.map(s => (
            <div key={s.id}
              className={`flex items-start gap-2 px-2 py-2 rounded-md cursor-pointer text-xs ${
                activeId === s.id ? 'bg-accent/15 text-ink' : 'text-ink2 hover:bg-white/5'
              }`}
              onClick={() => setActiveId(s.id!)}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{s.name}</div>
                <div className="text-[10px] text-muted mt-0.5">{s.symbol} · {new Date(s.updatedAt).toLocaleDateString()}</div>
              </div>
            </div>
          ))}
        </aside>

        {/* Editor + results */}
        <section className="card !p-0 flex flex-col overflow-hidden">
          {!draft ? (
            <Empty text="Select or create a strategy on the left." />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-hairline">
                <input
                  className="input !w-56 !text-sm"
                  value={draft.name}
                  onChange={e => setDraft(d => d && { ...d, name: e.target.value })}
                  placeholder="Strategy name"
                />
                <select
                  className="input !w-auto !text-xs"
                  value={draft.symbol}
                  onChange={e => setDraft(d => d && { ...d, symbol: e.target.value })}
                >
                  {symbols.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <input
                  type="number" step="0.05"
                  title="Spread"
                  className="input !w-20 !text-xs"
                  value={draft.spread}
                  onChange={e => setDraft(d => d && { ...d, spread: +e.target.value })}
                />
                <input
                  type="number" step="0.5"
                  title="Commission per lot (round-turn)"
                  className="input !w-20 !text-xs"
                  value={draft.commissionPerLot}
                  onChange={e => setDraft(d => d && { ...d, commissionPerLot: +e.target.value })}
                />
                <input
                  type="number" step="500"
                  title="Starting balance"
                  className="input !w-24 !text-xs"
                  value={draft.startingBalance}
                  onChange={e => setDraft(d => d && { ...d, startingBalance: +e.target.value })}
                />
                <input
                  type="date"
                  title="From (UTC, optional)"
                  className="input !w-36 !text-xs"
                  value={draft.from ? new Date(draft.from * 1000).toISOString().slice(0, 10) : ''}
                  onChange={e => setDraft(d => d && { ...d, from: e.target.value ? Math.floor(new Date(e.target.value + 'T00:00:00Z').getTime() / 1000) : undefined })}
                />
                <input
                  type="date"
                  title="To (UTC, optional)"
                  className="input !w-36 !text-xs"
                  value={draft.to ? new Date(draft.to * 1000).toISOString().slice(0, 10) : ''}
                  onChange={e => setDraft(d => d && { ...d, to: e.target.value ? Math.floor(new Date(e.target.value + 'T23:59:59Z').getTime() / 1000) : undefined })}
                />
                <div className="flex-1" />
                <button className="btn-ghost text-xs" onClick={save} disabled={!draft.name.trim()}>Save</button>
                {draft.id !== undefined && <button className="btn-ghost text-xs !text-down" onClick={del}>Delete</button>}
                {running
                  ? <button className="btn-ghost text-xs" disabled>Running…</button>
                  : <button className="btn-primary text-xs" onClick={run}>▶ Run backtest</button>}
              </div>

              <div className="flex-1 min-h-0 grid grid-rows-[minmax(180px,1fr)_auto_minmax(200px,2fr)]">
                {/* Code editor (Monaco — same one VS Code uses) */}
                <div className="border-b border-hairline flex flex-col min-h-0">
                  <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted flex-wrap">
                    <span>Python — <span className="text-ink2">def on_bar(ctx): …</span></span>
                    <span className="mx-1 opacity-40">·</span>
                    <span>Load example:</span>
                    {STRATEGY_EXAMPLES.map((e, i) => (
                      <button key={i} className="btn-ghost !text-[11px] !py-0 !px-1.5"
                        onClick={() => setDraft(d => d && { ...d, code: e.code })}
                        title={e.description}
                      >{e.name}</button>
                    ))}
                    <div className="flex-1" />
                    <label className="flex items-center gap-1 text-[11px] text-ink2 cursor-pointer" title="When on, saves silently strip trailing whitespace, expand leading tabs to 4 spaces, and ensure a final newline. Semantics never change.">
                      <input type="checkbox" className="accent-[#3987e5]" checked={autoFixOn} onChange={e => setAutoFixOn(e.target.checked)} />
                      Auto-fix on save
                    </label>
                    <button className="btn-ghost !text-[11px] !py-0 !px-1.5" onClick={formatNow} title="Format now — same rules Auto-fix applies on save">Format</button>
                  </div>
                  <div className="flex-1 min-h-0 border-t border-hairline">
                    <Editor
                      value={draft.code}
                      onChange={v => setDraft(d => d && { ...d, code: v ?? '' })}
                      language="python"
                      theme="vs-dark"
                      onMount={onEditorMount}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 12.5,
                        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, Menlo, monospace',
                        tabSize: 4,
                        insertSpaces: true,
                        renderLineHighlight: 'gutter',
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        wordWrap: 'off',
                        automaticLayout: true,
                        padding: { top: 8, bottom: 8 },
                        lineNumbersMinChars: 3,
                        overviewRulerBorder: false,
                        // Keep the built-in Python language service; our lint layer feeds
                        // markers separately via setModelMarkers so syntax errors show
                        // with the same red squiggles you'd get in VS Code.
                      }}
                      loading={<div className="p-3 text-xs text-muted">Loading editor…</div>}
                    />
                  </div>
                  <ProblemsStrip issues={issues} />
                </div>

                {/* Progress / Pyodide status */}
                <PyRuntimeBar pyStatus={pyStatus} progress={progress} />

                {/* Results */}
                <div className="min-h-0 overflow-y-auto">
                  {result
                    ? <ResultsPanel result={result} strategy={draft} />
                    : <Empty text="Run the strategy to see equity curve, stats, and hourly breakdown here." />}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function PyRuntimeBar({ pyStatus, progress }: { pyStatus: LoadStatus; progress: RunProgress | null }) {
  const showLoader = pyStatus.phase === 'downloading-loader' || pyStatus.phase === 'booting-runtime'
  const isError = pyStatus.phase === 'error'
  const pct = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : null
  return (
    <div className="px-3 py-1.5 border-b border-hairline text-[11px] flex items-center gap-3">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${
        pyStatus.phase === 'ready' ? 'bg-up' : isError ? 'bg-down' : showLoader ? 'bg-warn animate-pulse' : 'bg-muted'
      }`} />
      <span className={isError ? 'text-down' : 'text-muted'}>
        {isError ? `Python runtime error: ${pyStatus.error}` : pyStatus.message}
      </span>
      {progress && (
        <span className="text-muted">
          · {progress.message}{pct !== null ? ` (${pct}%)` : ''}
        </span>
      )}
      {pyStatus.phase === 'idle' && (
        <span className="text-muted ml-auto">First Run downloads ~10 MB of Python runtime from cdnjs; cached after that.</span>
      )}
    </div>
  )
}

function ResultsPanel({ result, strategy }: { result: BacktestResult; strategy: StrategyDef }) {
  const summary = useMemo(() => summarize(result.trades), [result.trades])
  const hourStats = useMemo(() => hourlyBreakdown(result.trades), [result.trades])
  const dowStats = useMemo(() => dowBreakdown(result.trades), [result.trades])

  if (result.error) {
    return (
      <div className="p-4">
        <div className="text-xs text-down whitespace-pre-wrap">{result.error}</div>
        {result.logs.length > 0 && (
          <details className="mt-3 text-[11px] text-muted"><summary className="cursor-pointer">Logs</summary>
            <pre className="whitespace-pre-wrap mt-1">{result.logs.join('\n')}</pre>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <MiniStat label="Net P&L" value={<PnlText v={summary.netPnl} digits={0} />} />
        <MiniStat label="Win rate" value={summary.n ? fmtPct(summary.winRate) : '—'} sub={`${summary.wins}W / ${summary.losses}L`} />
        <MiniStat label="Profit factor" value={summary.n ? (isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : '∞') : '—'} />
        <MiniStat label="Expectancy" value={summary.n ? fmtUsd(summary.expectancy) : '—'} sub="/trade" />
        <MiniStat label="Avg R" value={summary.n ? fmtR(summary.avgR) : '—'} />
        <MiniStat label="Max drawdown" value={fmtUsd(summary.maxDrawdown)} />
        <MiniStat label="Trades" value={String(summary.n)} />
        <MiniStat label="Best / Worst" value={<>{fmtUsd(summary.bestTrade, 0)} / <PnlText v={summary.worstTrade} digits={0} /></>} />
        <MiniStat label="Streak (max)" value={`+${summary.maxWinStreak} / -${summary.maxLossStreak}`} />
        <MiniStat label="Avg duration" value={summary.n ? fmtDuration(summary.avgDurationSec) : '—'} />
        <MiniStat label="Final balance" value={fmtUsd(result.finalBalance)} />
        <MiniStat label="Runtime" value={`${result.runtimeSeconds.toFixed(1)}s`} />
      </div>

      {/* Equity curve */}
      {result.equity.length > 0 && (
        <div className="card !p-2">
          <div className="text-[11px] text-muted mb-1">Equity curve</div>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <LineChart data={result.equity} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: AXIS }} tickFormatter={t => new Date(t * 1000).toISOString().slice(0, 10)} minTickGap={40} />
                <YAxis tick={{ fontSize: 10, fill: AXIS }} tickFormatter={v => (v / 1000).toFixed(1) + 'k'} width={44} />
                <Tooltip {...TOOLTIP} labelFormatter={t => new Date((t as number) * 1000).toISOString().slice(0, 16).replace('T', ' ')} formatter={v => fmtUsd(+(v as number))} />
                <ReferenceLine y={strategy.startingBalance} stroke={AXIS} strokeDasharray="2 4" />
                <Line type="monotone" dataKey="equity" stroke={result.finalBalance >= strategy.startingBalance ? UP : DOWN} dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Hourly breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="card !p-2">
          <div className="text-[11px] text-muted mb-1">By hour of day (UTC)</div>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <RCBarChart data={hourStats} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: AXIS }} />
                <YAxis tick={{ fontSize: 10, fill: AXIS }} tickFormatter={v => (v as number).toFixed(0)} width={44} />
                <Tooltip {...TOOLTIP} formatter={(v, k) => k === 'pnl' ? fmtUsd(+(v as number)) : String(v)} />
                <RCBar dataKey="pnl" isAnimationActive={false}>
                  {hourStats.map((h, i) => (
                    <Cell key={i} fill={h.pnl >= 0 ? UP : DOWN} fillOpacity={h.n === 0 ? 0.15 : 0.85} />
                  ))}
                </RCBar>
              </RCBarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[10px] text-muted mt-1">
            Best hour: {bestHour(hourStats)} · Worst hour: {worstHour(hourStats)}
          </div>
        </div>

        <div className="card !p-2">
          <div className="text-[11px] text-muted mb-1">By day of week (UTC)</div>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <RCBarChart data={dowStats} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: AXIS }} />
                <YAxis tick={{ fontSize: 10, fill: AXIS }} tickFormatter={v => (v as number).toFixed(0)} width={44} />
                <Tooltip {...TOOLTIP} formatter={v => fmtUsd(+(v as number))} />
                <RCBar dataKey="pnl" isAnimationActive={false}>
                  {dowStats.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? UP : DOWN} fillOpacity={d.n === 0 ? 0.15 : 0.85} />)}
                </RCBar>
              </RCBarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* AI analysis */}
      <AIAnalysisPanel result={result} strategy={strategy} hourStats={hourStats} dowStats={dowStats} />

      {/* Trades table */}
      {result.trades.length > 0 && (
        <div className="card !p-0 overflow-hidden">
          <div className="px-3 py-1.5 text-[11px] text-muted">Trades ({result.trades.length})</div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="th">Entry</th><th className="th">Exit</th><th className="th">Dir</th>
                  <th className="th">Entry px</th><th className="th">Exit px</th>
                  <th className="th text-right">P&L</th><th className="th text-right">R</th><th className="th">Exit</th>
                </tr>
              </thead>
              <tbody>
                {result.trades.slice(-500).reverse().map((t, i) => (
                  <tr key={i}>
                    <td className="td text-muted">{fmtDateTime(t.entryTime)}</td>
                    <td className="td text-muted">{fmtDateTime(t.exitTime)}</td>
                    <td className={`td ${t.direction === 'long' ? 'text-up' : 'text-down'}`}>{t.direction}</td>
                    <td className="td">{t.entryPrice}</td>
                    <td className="td">{t.exitPrice}</td>
                    <td className="td text-right"><PnlText v={t.pnl} digits={2} /></td>
                    <td className="td text-right text-muted">{fmtR(t.rMultiple)}</td>
                    <td className="td text-muted uppercase text-[10px]">{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.trades.length > 500 && (
              <div className="text-[11px] text-muted p-2">Showing most recent 500 of {result.trades.length}.</div>
            )}
          </div>
        </div>
      )}

      {result.logs.length > 0 && (
        <details className="text-[11px] text-muted card !p-2"><summary className="cursor-pointer">Logs ({result.logs.length})</summary>
          <pre className="whitespace-pre-wrap mt-1">{result.logs.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="card !p-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="text-sm font-semibold text-ink mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

function ProblemsStrip({ issues }: { issues: LintIssue[] }) {
  if (issues.length === 0) {
    return (
      <div className="px-3 py-1 text-[11px] text-up border-t border-hairline bg-black/20 flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-up" /> No problems.
      </div>
    )
  }
  return (
    <div className="border-t border-hairline bg-black/20 max-h-24 overflow-y-auto">
      {issues.map((iss, i) => (
        <div key={i} className="flex items-baseline gap-2 px-3 py-1 text-[11px]">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${iss.severity === 'error' ? 'bg-down' : 'bg-warn'}`} />
          <span className={iss.severity === 'error' ? 'text-down' : 'text-warn'}>{iss.severity}</span>
          <span className="text-muted">line {iss.line}:{iss.column}</span>
          <span className="text-ink2">{iss.message}</span>
        </div>
      ))}
    </div>
  )
}

function bestHour(hs: { hour: number; pnl: number; n: number }[]): string {
  const active = hs.filter(h => h.n > 0)
  if (!active.length) return '—'
  const top = [...active].sort((a, b) => b.pnl - a.pnl)[0]
  return `${String(top.hour).padStart(2, '0')}:00 (${fmtUsd(top.pnl, 0)}, ${top.n} trades)`
}
function worstHour(hs: { hour: number; pnl: number; n: number }[]): string {
  const active = hs.filter(h => h.n > 0)
  if (!active.length) return '—'
  const bot = [...active].sort((a, b) => a.pnl - b.pnl)[0]
  return `${String(bot.hour).padStart(2, '0')}:00 (${fmtUsd(bot.pnl, 0)}, ${bot.n} trades)`
}

// ─── AI analysis ────────────────────────────────────────────────────────────

function AIAnalysisPanel({
  result, strategy, hourStats, dowStats,
}: {
  result: BacktestResult
  strategy: StrategyDef
  hourStats: { hour: number; n: number; wins: number; pnl: number }[]
  dowStats: { day: string; n: number; wins: number; pnl: number }[]
}) {
  const [cfg, setCfg] = useState<AIConfig>(DEFAULT_AI_CONFIG)
  const [provider, setProvider] = useState<AIProvider>('openai')
  const [model, setModel] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [answer, setAnswer] = useState('')
  const [err, setErr] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void loadAIConfig().then(c => {
      setCfg(c)
      setProvider(c.defaultProvider)
      setModel(c.defaultProvider === 'ollama' ? c.ollamaModel : c.defaultModel)
    })
  }, [])

  const ask = async () => {
    setErr('')
    setAnswer('')
    setStreaming(true)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const s = summarize(result.trades)
      const bestHours = [...hourStats].filter(h => h.n > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 6)
      const worstHours = [...hourStats].filter(h => h.n > 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3)
      const payload = [
        `# Backtest results for strategy "${strategy.name}"`,
        `Symbol: ${strategy.symbol} · Spread: ${strategy.spread} · Commission/lot: ${strategy.commissionPerLot} · Starting balance: ${strategy.startingBalance}`,
        strategy.from || strategy.to ? `Window: ${strategy.from ? fmtDate(strategy.from) : '…'} → ${strategy.to ? fmtDate(strategy.to) : '…'}` : `Window: all available data`,
        ``,
        `## Overall`,
        `Trades: ${s.n} · Net P&L: ${fmtUsd(s.netPnl)} · WR: ${fmtPct(s.winRate)} · PF: ${isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} · Exp: ${fmtUsd(s.expectancy)}/trade · Max DD: ${fmtUsd(s.maxDrawdown)}`,
        ``,
        `## Top hours (UTC, by P&L)`,
        ...bestHours.map(h => `- ${String(h.hour).padStart(2, '0')}:00 → ${fmtUsd(h.pnl)}, n=${h.n}, wins=${h.wins}`),
        ``,
        `## Worst hours (UTC)`,
        ...worstHours.map(h => `- ${String(h.hour).padStart(2, '0')}:00 → ${fmtUsd(h.pnl)}, n=${h.n}, wins=${h.wins}`),
        ``,
        `## By day of week (UTC)`,
        ...dowStats.map(d => `- ${d.day}: ${fmtUsd(d.pnl)}, n=${d.n}, wins=${d.wins}`),
        ``,
        `## Strategy code`,
        '```python',
        strategy.code,
        '```',
      ].join('\n')
      const messages = [
        { role: 'system' as const, content: CHAT_SYSTEM_PROMPT + '\n\nYou are analysing a backtest. Focus first on best-time-of-day and best-day-of-week windows to run this strategy, grounded in the numbers below. Then list 2-3 concrete tweaks to the code that would likely improve results. Be direct.' },
        { role: 'user' as const, content: payload },
      ]
      let acc = ''
      await streamChat(
        { provider, model, messages, ollamaBaseUrl: cfg.ollamaBaseUrl, temperature: 0.3 },
        d => { acc += d; setAnswer(acc) },
        abort.signal,
      )
    } catch (e: any) {
      if (!/abort/i.test(String(e?.message ?? e))) setErr(String(e?.message ?? e))
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-ink">AI analysis — best time of day + tweaks</div>
        <div className="flex-1" />
        <select className="input !w-auto !text-xs" value={provider} disabled={streaming}
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
          <input className="input !w-auto !text-xs" value={model} onChange={e => setModel(e.target.value)} disabled={streaming} />
        ) : (
          <select className="input !w-auto !text-xs" value={model} onChange={e => setModel(e.target.value)} disabled={streaming}>
            {modelsFor(provider, cfg).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        {streaming
          ? <button className="btn-ghost text-xs" onClick={() => abortRef.current?.abort()}>Stop</button>
          : <button className="btn-primary text-xs" onClick={ask} disabled={result.trades.length === 0}>Analyze</button>}
      </div>
      {err && <div className="text-xs text-down mt-2">{err}</div>}
      {answer && (
        <div className="rounded-lg border border-hairline bg-black/20 p-3 text-sm text-ink2 whitespace-pre-wrap max-h-[40vh] overflow-y-auto leading-relaxed mt-3">
          {answer}
        </div>
      )}
      {!answer && !err && (
        <p className="text-[11px] text-muted mt-2">
          Sends the strategy's stats + top/worst hours + DOW breakdown + your Python code to the selected model,
          then streams back where the edge concentrates and how to sharpen it.
        </p>
      )}
    </div>
  )
}
