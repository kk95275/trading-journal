// Python strategy backtester. Users write Python (via Pyodide), define
// on_bar(ctx), run against 1m historical bars for any imported instrument,
// and get equity curve + stats + hourly breakdown. "Analyze with AI" pipes
// the results through the same streamChat pipeline the journal uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Bar as BarChart, Bar as RCBar, BarChart as RCBarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Editor, { type OnMount } from '@monaco-editor/react'
import { db, getSetting, setSetting, getStrategyFiles, type StrategyDef, type StrategyFile } from '../db'
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

/** Monaco options shared between the inline editor and the expanded overlay. */
const monacoOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, Menlo, monospace',
  tabSize: 4,
  insertSpaces: true,
  renderLineHighlight: 'gutter' as const,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  wordWrap: 'off' as const,
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
  lineNumbersMinChars: 3,
  overviewRulerBorder: false,
}

// Suppress a false-positive: recharts imports `Bar` twice above for clarity.
void BarChart; void RCBar

export default function Strategies() {
  const strategies = useLiveQuery(() => db.strategies.orderBy('updatedAt').reverse().toArray(), [], [] as StrategyDef[])
  const symbols = useSymbolList()
  const [activeId, setActiveId] = useState<number | null>(null)
  const [draft, setDraft] = useState<StrategyDef | null>(null)
  const [activeFile, setActiveFile] = useState<string>('main.py')
  const [expanded, setExpanded] = useState(false)
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

  // Bring editor into sync whenever the active strategy changes. We normalize
  // the multi-file shape here so downstream code only sees files[] + mainFile.
  useEffect(() => {
    if (active) {
      const { files, mainFile } = getStrategyFiles(active)
      setDraft({ ...active, files, mainFile })
      setActiveFile(mainFile)
    } else {
      setDraft(null)
    }
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

  // Debounced live lint on the active file. Fires 400ms after typing stops.
  // Warms pyodide the first time (~10 MB download).
  const activeContent = useMemo(() => {
    if (!draft?.files) return ''
    return draft.files.find(f => f.name === activeFile)?.content ?? ''
  }, [draft?.files, activeFile])

  useEffect(() => {
    if (!draft) { setIssues([]); return }
    const code = activeContent
    const handle = window.setTimeout(async () => {
      const found = await lintPython(code)
      // Only reject the on_bar warning if this isn't the main file.
      const isMain = activeFile === (draft.mainFile ?? 'main.py')
      const filtered = isMain ? found : found.filter(f => !/on_bar\(ctx\)/.test(f.message))
      setIssues(filtered)
      const editor = editorRef.current, monaco = monacoRef.current
      if (editor && monaco) {
        const model = editor.getModel()
        if (model) {
          monaco.editor.setModelMarkers(model, 'py-lint', filtered.map(iss => ({
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
  }, [activeContent, activeFile, draft?.id, draft?.mainFile])

  const startNew = () => {
    const now = Date.now()
    const seed = STRATEGY_EXAMPLES[0]
    setActiveId(null)
    setDraft({
      name: 'New strategy',
      files: [{ name: 'main.py', content: seed.code }],
      mainFile: 'main.py',
      symbol: symbols[0] ?? 'XAUUSD',
      spread: 0.3,
      commissionPerLot: 6,
      startingBalance: 10000,
      createdAt: now,
      updatedAt: now,
    })
    setActiveFile('main.py')
    setResult(null)
  }

  const save = async () => {
    if (!draft) return
    // Apply auto-fix silently on save to every file (semantics unchanged — see
    // autoFix() docstring). Sync so the editor reflects the cleaned version.
    const files = draft.files ?? []
    const nextFiles = autoFixOn ? files.map(f => ({ ...f, content: autoFix(f.content) })) : files
    const rec: StrategyDef = { ...draft, files: nextFiles, updatedAt: Date.now() }
    // Keep `code` in sync with main file for backward compat if the record ever
    // gets read by an older build.
    const main = nextFiles.find(f => f.name === (draft.mainFile ?? 'main.py'))
    if (main) rec.code = main.content
    if (nextFiles !== files) setDraft(rec)
    if (rec.id !== undefined) {
      // put() replaces the whole record; update() would want a partial spec
      // that TS can't infer through the files array shape.
      await db.strategies.put(rec)
    } else {
      const id = await db.strategies.add({ ...rec, createdAt: Date.now() })
      setActiveId(id as number)
    }
  }

  const formatNow = () => {
    if (!draft) return
    const files = (draft.files ?? []).map(f =>
      f.name === activeFile ? { ...f, content: autoFix(f.content) } : f,
    )
    setDraft({ ...draft, files })
  }

  // File tab actions.
  const setActiveFileContent = (content: string) => {
    if (!draft) return
    const files = (draft.files ?? []).map(f => f.name === activeFile ? { ...f, content } : f)
    setDraft({ ...draft, files })
  }
  const addFile = () => {
    if (!draft) return
    const files = draft.files ?? []
    // Pick a unique default name.
    let n = 1, name = `lib${n}.py`
    while (files.some(f => f.name === name)) { n++; name = `lib${n}.py` }
    setDraft({ ...draft, files: [...files, { name, content: '# New module — imported from main.py as `import ' + name.slice(0, -3) + '`\n' }] })
    setActiveFile(name)
  }
  const renameFile = (oldName: string) => {
    if (!draft) return
    const raw = prompt('Rename file', oldName)
    if (raw == null) return
    const clean = raw.trim()
    if (!clean) return
    const withExt = clean.endsWith('.py') ? clean : `${clean}.py`
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.py$/.test(withExt)) {
      alert('Name must be letters/digits/underscore, start with a letter, and end in .py')
      return
    }
    const files = draft.files ?? []
    if (files.some(f => f.name === withExt)) { alert(`${withExt} already exists`); return }
    const nextFiles = files.map(f => f.name === oldName ? { ...f, name: withExt } : f)
    const nextMain = draft.mainFile === oldName ? withExt : draft.mainFile
    setDraft({ ...draft, files: nextFiles, mainFile: nextMain })
    if (activeFile === oldName) setActiveFile(withExt)
  }
  const deleteFile = (name: string) => {
    if (!draft) return
    const files = draft.files ?? []
    if (files.length <= 1) { alert('At least one file is required.'); return }
    if (name === (draft.mainFile ?? 'main.py')) { alert('Set another file as main first, then delete this one.'); return }
    if (!confirm(`Delete ${name}? This can't be undone.`)) return
    const nextFiles = files.filter(f => f.name !== name)
    setDraft({ ...draft, files: nextFiles })
    if (activeFile === name) setActiveFile(nextFiles[0].name)
  }
  const setAsMain = (name: string) => {
    if (!draft) return
    setDraft({ ...draft, mainFile: name })
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
      const availFrom = chunks[0].from
      const availTo = chunks[chunks.length - 1].to
      const totalManifestBars = chunks.reduce((s, c) => s + (c.bars ?? 0), 0)
      // Fall back to the full available range when the user hasn't set from/to,
      // and clamp any user-specified range that falls outside available data so
      // a slightly-off date picker doesn't return zero bars.
      const wantedFrom = draft.from ?? availFrom
      const wantedTo   = draft.to   ?? availTo
      const from = Math.max(wantedFrom, availFrom)
      const to   = Math.min(wantedTo,   availTo)
      if (from > to) {
        throw new Error(
          `The from/to range for ${draft.symbol} doesn't overlap any imported data.\n` +
          `Requested: ${fmtDate(wantedFrom)} → ${fmtDate(wantedTo)}\n` +
          `Available: ${fmtDate(availFrom)} → ${fmtDate(availTo)}\n` +
          `Clear the from/to inputs to run against all data.`,
        )
      }
      const bars = await getBars(draft.symbol, '1m', from, to)
      if (!bars.length) {
        throw new Error(
          `Loaded 0 bars for ${draft.symbol} even though the manifest lists ${totalManifestBars.toLocaleString()} bars ` +
          `across ${chunks.length} chunk(s).\n` +
          `Requested window: ${fmtDate(from)} → ${fmtDate(to)}\n` +
          `Available: ${fmtDate(availFrom)} → ${fmtDate(availTo)}\n` +
          `If this is a fresh install, import 1m data under Settings → Instruments and try again.`,
        )
      }

      // Kick off pyodide load so its status flows to the UI even before runBacktest awaits it.
      void loadPyodideRuntime()

      const { files, mainFile } = getStrategyFiles(draft)
      const r = await runBacktest(
        {
          symbol: draft.symbol,
          bars,
          spread: draft.spread,
          commissionPerLot: draft.commissionPerLot,
          startingBalance: draft.startingBalance,
        },
        files,
        mainFile,
        p => setProgress(p),
      )
      setResult(r)
    } catch (e: any) {
      setResult({
        trades: [], equity: [], finalBalance: draft.startingBalance,
        logs: [], error: String(e?.message ?? e),
        errorCount: 1, barsProcessed: 0, runtimeSeconds: 0,
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
                {/* Code editor (Monaco — same one VS Code uses) with per-file tabs */}
                <div className="border-b border-hairline flex flex-col min-h-0">
                  <FileTabBar
                    files={draft.files ?? []}
                    activeFile={activeFile}
                    mainFile={draft.mainFile ?? 'main.py'}
                    onSelect={setActiveFile}
                    onAdd={addFile}
                    onRename={renameFile}
                    onDelete={deleteFile}
                    onSetMain={setAsMain}
                    autoFixOn={autoFixOn}
                    setAutoFixOn={setAutoFixOn}
                    formatNow={formatNow}
                    onExpandToggle={() => setExpanded(v => !v)}
                    expanded={false}
                    examples={STRATEGY_EXAMPLES}
                    onLoadExample={code => {
                      const files = (draft.files ?? []).map(f =>
                        f.name === activeFile ? { ...f, content: code } : f,
                      )
                      setDraft({ ...draft, files })
                    }}
                  />
                  <div className="flex-1 min-h-0 border-t border-hairline">
                    <Editor
                      value={activeContent}
                      onChange={v => setActiveFileContent(v ?? '')}
                      language="python"
                      theme="vs-dark"
                      onMount={onEditorMount}
                      options={monacoOptions}
                      loading={<div className="p-3 text-xs text-muted">Loading editor…</div>}
                      // Force a fresh model per file so Monaco tracks per-file
                      // undo history + lint markers correctly.
                      path={activeFile}
                    />
                  </div>
                  <ProblemsStrip issues={issues} activeFile={activeFile} />
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

      {/* Fullscreen editor overlay — same tab bar and Monaco, filling the window.
          Config / results / sidebar all stay hidden until Restore. */}
      {expanded && draft && (
        <ExpandedEditor
          draft={draft}
          activeFile={activeFile}
          activeContent={activeContent}
          issues={issues}
          autoFixOn={autoFixOn}
          setAutoFixOn={setAutoFixOn}
          formatNow={formatNow}
          examples={STRATEGY_EXAMPLES}
          onLoadExample={code => {
            const files = (draft.files ?? []).map(f =>
              f.name === activeFile ? { ...f, content: code } : f,
            )
            setDraft({ ...draft, files })
          }}
          onSelectFile={setActiveFile}
          onAddFile={addFile}
          onRenameFile={renameFile}
          onDeleteFile={deleteFile}
          onSetMain={setAsMain}
          onEdit={setActiveFileContent}
          onMount={onEditorMount}
          onSave={save}
          onRun={run}
          running={running}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}

interface ExpandedEditorProps {
  draft: StrategyDef
  activeFile: string
  activeContent: string
  issues: LintIssue[]
  autoFixOn: boolean
  setAutoFixOn: (v: boolean) => void
  formatNow: () => void
  examples: { name: string; code: string; description: string }[]
  onLoadExample: (code: string) => void
  onSelectFile: (name: string) => void
  onAddFile: () => void
  onRenameFile: (name: string) => void
  onDeleteFile: (name: string) => void
  onSetMain: (name: string) => void
  onEdit: (content: string) => void
  onMount: OnMount
  onSave: () => void | Promise<void>
  onRun: () => void | Promise<void>
  running: boolean
  onClose: () => void
}

function ExpandedEditor(p: ExpandedEditorProps) {
  // Esc restores the normal layout. Wire once at the overlay's mount so it
  // doesn't leak listeners when collapsed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); p.onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p.onClose])

  return (
    <div className="fixed inset-0 z-40 bg-surface flex flex-col">
      {/* Compact top strip: strategy name, save/run, restore. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-surface text-sm">
        <span className="text-ink font-semibold">{p.draft.name}</span>
        <span className="text-[11px] text-muted">— editing {p.activeFile}</span>
        <div className="flex-1" />
        <button className="btn-ghost text-xs" onClick={p.onSave}>Save</button>
        {p.running
          ? <button className="btn-ghost text-xs" disabled>Running…</button>
          : <button className="btn-primary text-xs" onClick={p.onRun}>▶ Run</button>}
        <button className="btn-ghost text-xs" onClick={p.onClose} title="Restore normal layout (Esc)">⤡ Restore</button>
      </div>
      <FileTabBar
        files={p.draft.files ?? []}
        activeFile={p.activeFile}
        mainFile={p.draft.mainFile ?? 'main.py'}
        onSelect={p.onSelectFile}
        onAdd={p.onAddFile}
        onRename={p.onRenameFile}
        onDelete={p.onDeleteFile}
        onSetMain={p.onSetMain}
        autoFixOn={p.autoFixOn}
        setAutoFixOn={p.setAutoFixOn}
        formatNow={p.formatNow}
        onExpandToggle={p.onClose}
        expanded
        examples={p.examples}
        onLoadExample={p.onLoadExample}
      />
      <div className="flex-1 min-h-0 border-t border-hairline">
        <Editor
          value={p.activeContent}
          onChange={v => p.onEdit(v ?? '')}
          language="python"
          theme="vs-dark"
          onMount={p.onMount}
          options={monacoOptions}
          path={p.activeFile}
          loading={<div className="p-3 text-xs text-muted">Loading editor…</div>}
        />
      </div>
      <ProblemsStrip issues={p.issues} activeFile={p.activeFile} />
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

  return (
    <div className="p-3 space-y-3">
      {/* Errors get a loud banner ABOVE the results rather than replacing them —
          a strategy that threw on some bars still produced partial results
          worth seeing, and hiding the stats made a thrown exception look
          identical to "never traded". */}
      {result.error && (
        <div className="rounded-lg border border-down/50 bg-down/10 p-3 space-y-1">
          <div className="text-sm font-semibold text-down">
            ⚠ Strategy raised a Python error
            {result.errorCount > 1 && <span className="font-normal"> — on {result.errorCount.toLocaleString()} bars</span>}
          </div>
          <pre className="text-[11px] text-ink2 whitespace-pre-wrap leading-relaxed">{result.error}</pre>
          <div className="text-[11px] text-muted">
            Simulated {result.barsProcessed.toLocaleString()} bars before this report. Fix the error above, then Run again.
          </div>
        </div>
      )}

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

      {/* Always rendered — an empty Logs section tells you ctx.log() never
          fired, which is itself diagnostic. Open by default when the run
          errored or produced no trades, since that's when you need it. */}
      <details
        className="text-[11px] text-muted card !p-2"
        open={!!result.error || result.trades.length === 0}
      >
        <summary className="cursor-pointer">Logs ({result.logs.length})</summary>
        {result.logs.length > 0 ? (
          <pre className="whitespace-pre-wrap mt-1 max-h-72 overflow-y-auto">{result.logs.join('\n')}</pre>
        ) : (
          <div className="mt-1">
            No output — your strategy never called <span className="text-ink2">ctx.log(...)</span>.
          </div>
        )}
      </details>
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

function ProblemsStrip({ issues, activeFile }: { issues: LintIssue[]; activeFile?: string }) {
  if (issues.length === 0) {
    return (
      <div className="px-3 py-1 text-[11px] text-up border-t border-hairline bg-black/20 flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-up" /> No problems{activeFile ? ` in ${activeFile}` : ''}.
      </div>
    )
  }
  return (
    <div className="border-t border-hairline bg-black/20 max-h-24 overflow-y-auto">
      {issues.map((iss, i) => (
        <div key={i} className="flex items-baseline gap-2 px-3 py-1 text-[11px]">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${iss.severity === 'error' ? 'bg-down' : 'bg-warn'}`} />
          <span className={iss.severity === 'error' ? 'text-down' : 'text-warn'}>{iss.severity}</span>
          {activeFile && <span className="text-muted">{activeFile}</span>}
          <span className="text-muted">line {iss.line}:{iss.column}</span>
          <span className="text-ink2">{iss.message}</span>
        </div>
      ))}
    </div>
  )
}

/** Tabbed file-name bar above the editor. Handles rename / delete / add /
 * set-main plus the auto-fix/format/expand controls. Kept as a plain function
 * component so both the inline editor and the fullscreen overlay can render it. */
function FileTabBar({
  files, activeFile, mainFile, onSelect, onAdd, onRename, onDelete, onSetMain,
  autoFixOn, setAutoFixOn, formatNow, onExpandToggle, expanded, examples, onLoadExample,
}: {
  files: StrategyFile[]
  activeFile: string
  mainFile: string
  onSelect: (name: string) => void
  onAdd: () => void
  onRename: (name: string) => void
  onDelete: (name: string) => void
  onSetMain: (name: string) => void
  autoFixOn: boolean
  setAutoFixOn: (v: boolean) => void
  formatNow: () => void
  onExpandToggle: () => void
  expanded: boolean
  examples: { name: string; code: string; description: string }[]
  onLoadExample: (code: string) => void
}) {
  return (
    <>
      {/* File tabs — main gets a star, others get delete on hover. */}
      <div className="flex items-center gap-0.5 px-2 pt-1 bg-black/20 overflow-x-auto flex-shrink-0">
        {files.map(f => {
          const isActive = f.name === activeFile
          const isMain = f.name === mainFile
          return (
            <div
              key={f.name}
              className={`group flex items-center gap-1 pl-2 pr-1 py-1 text-[11px] rounded-t cursor-pointer border-t border-x border-hairline shrink-0 ${
                isActive ? 'bg-surface text-ink' : 'bg-transparent text-ink2 hover:bg-white/5 border-transparent'
              }`}
              onClick={() => onSelect(f.name)}
              onDoubleClick={e => { e.stopPropagation(); onRename(f.name) }}
              title={isMain ? 'Main entry point — cannot be deleted' : 'Double-click to rename'}
            >
              {isMain && <span className="text-warn">★</span>}
              <span>{f.name}</span>
              {!isMain && files.length > 1 && (
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-down text-sm px-1 leading-none"
                  title="Delete file"
                  onClick={e => { e.stopPropagation(); onDelete(f.name) }}
                >×</button>
              )}
              {!isMain && (
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-warn text-xs px-1 leading-none"
                  title="Set as main"
                  onClick={e => { e.stopPropagation(); onSetMain(f.name) }}
                >☆</button>
              )}
            </div>
          )
        })}
        <button
          className="ml-1 text-muted hover:text-ink text-xs px-2 py-1"
          title="Add a new .py file"
          onClick={onAdd}
        >+</button>
      </div>

      {/* Utility row: examples · auto-fix · format · expand */}
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted flex-wrap flex-shrink-0">
        <span>Load into {activeFile}:</span>
        {examples.map((e, i) => (
          <button key={i} className="btn-ghost !text-[11px] !py-0 !px-1.5"
            onClick={() => onLoadExample(e.code)}
            title={e.description}
          >{e.name}</button>
        ))}
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-[11px] text-ink2 cursor-pointer" title="When on, saves silently strip trailing whitespace, expand leading tabs to 4 spaces, and ensure a final newline. Semantics never change.">
          <input type="checkbox" className="accent-[#3987e5]" checked={autoFixOn} onChange={e => setAutoFixOn(e.target.checked)} />
          Auto-fix on save
        </label>
        <button className="btn-ghost !text-[11px] !py-0 !px-1.5" onClick={formatNow} title="Format the current file — same rules Auto-fix applies on save">Format</button>
        <button className="btn-ghost !text-[11px] !py-0 !px-1.5" onClick={onExpandToggle} title={expanded ? 'Restore normal layout (Esc)' : 'Expand editor to fill the window'}>
          {expanded ? '⤡ Restore' : '⛶ Expand'}
        </button>
      </div>
    </>
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
