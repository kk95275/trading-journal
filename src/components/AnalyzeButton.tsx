import { useEffect, useRef, useState } from 'react'
import { db } from '../db'
import type { Trade } from '../lib/types'
import { streamChat, PROVIDER_LABELS, type AIProvider } from '../lib/ai'
import { buildTradeContext, ANALYSIS_SYSTEM_PROMPT } from '../lib/aiContext'
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

function AnalyzeModal({ trades, scope, onClose }: { trades: Trade[]; scope: string; onClose: () => void }) {
  const [cfg, setCfg] = useState<AIConfig>(DEFAULT_AI_CONFIG)
  const [provider, setProvider] = useState<AIProvider>('openai')
  const [model, setModel] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [contextBytes, setContextBytes] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void loadAIConfig().then(c => {
      setCfg(c)
      setProvider(c.defaultProvider)
      setModel(c.defaultProvider === 'ollama' ? c.ollamaModel : c.defaultModel)
    })
  }, [])

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }

  const run = async () => {
    setError('')
    setOutput('')
    setRunning(true)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const [setups, journal] = await Promise.all([db.setups.toArray(), db.journal.toArray()])
      const ctx = buildTradeContext(trades, setups, journal, { scope })
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
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">{trades.length} trades</span>
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
            {running
              ? <button className="btn-ghost text-xs" onClick={cancel}>Stop</button>
              : <button className="btn-primary text-xs" onClick={() => void run()}>
                  {output ? 'Re-run analysis' : 'Run analysis'}
                </button>}
          </div>
        </div>

        {error && <div className="text-xs text-down whitespace-pre-wrap">{error}</div>}

        {!output && !running && !error && (
          <div className="text-xs text-muted">
            Sends a compact summary of these {trades.length} trades (per-setup breakdown, session/hour stats,
            mistake tags, sample trades with notes) to the selected model, then streams back an analysis with
            a recommended strategy focus.
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
