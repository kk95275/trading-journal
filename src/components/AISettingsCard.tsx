import { useEffect, useState } from 'react'
import { getSetting, setSetting } from '../db'
import { isElectron } from '../lib/platform'
import { MODELS, PROVIDER_LABELS, setMemKey, type AIProvider, chat } from '../lib/ai'

export interface AIConfig {
  defaultProvider: AIProvider
  defaultModel: string
  ollamaBaseUrl: string
  ollamaModel: string
  // Custom models the user has typed (per provider).
  customModels: Partial<Record<AIProvider, string[]>>
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o-mini',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.1',
  customModels: {},
}

const PROVIDERS: AIProvider[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama']

export async function loadAIConfig(): Promise<AIConfig> {
  const raw = await getSetting<Partial<AIConfig>>('aiConfig', {})
  return { ...DEFAULT_AI_CONFIG, ...raw }
}

export function modelsFor(provider: AIProvider, cfg: AIConfig): { id: string; label: string }[] {
  const built = MODELS[provider].map(m => ({ id: m.id, label: m.label }))
  const custom = (cfg.customModels[provider] ?? []).map(id => ({ id, label: `${id} (custom)` }))
  const seen = new Set(built.map(b => b.id))
  return [...built, ...custom.filter(c => !seen.has(c.id))]
}

export default function AISettingsCard() {
  const [cfg, setCfg] = useState<AIConfig>(DEFAULT_AI_CONFIG)
  const [keys, setKeys] = useState<Partial<Record<AIProvider, string>>>({})
  const [hasKey, setHasKey] = useState<Partial<Record<AIProvider, boolean>>>({})
  const [status, setStatus] = useState<string>('')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void (async () => {
      setCfg(await loadAIConfig())
      if (isElectron && window.electronAPI?.aiHasKey) {
        const entries = await Promise.all(
          PROVIDERS.map(async p => [p, await window.electronAPI!.aiHasKey(p)] as const),
        )
        setHasKey(Object.fromEntries(entries))
      }
    })()
  }, [])

  const save = async (patch: Partial<AIConfig>) => {
    const next = { ...cfg, ...patch }
    setCfg(next)
    await setSetting('aiConfig', next)
  }

  const saveKey = async (provider: AIProvider) => {
    const key = (keys[provider] ?? '').trim()
    if (!key) return
    try {
      if (isElectron && window.electronAPI?.aiSetKey) {
        await window.electronAPI.aiSetKey(provider, key)
      } else {
        setMemKey(provider, key) // browser dev only — session-only
      }
      setHasKey(h => ({ ...h, [provider]: true }))
      setKeys(k => ({ ...k, [provider]: '' }))
      setStatus(`${PROVIDER_LABELS[provider]} key saved${isElectron ? ' (encrypted).' : ' (session-only).'}`)
      setTimeout(() => setStatus(''), 2500)
    } catch (e: any) {
      setStatus(`Failed to save key: ${String(e?.message ?? e)}`)
    }
  }

  const deleteKey = async (provider: AIProvider) => {
    if (!confirm(`Remove ${PROVIDER_LABELS[provider]} API key?`)) return
    if (isElectron && window.electronAPI?.aiDeleteKey) {
      await window.electronAPI.aiDeleteKey(provider)
    } else {
      setMemKey(provider, '')
    }
    setHasKey(h => ({ ...h, [provider]: false }))
    setStatus(`${PROVIDER_LABELS[provider]} key removed.`)
    setTimeout(() => setStatus(''), 2000)
  }

  const testConnection = async () => {
    setTesting(true)
    setStatus('Testing…')
    try {
      const model = cfg.defaultProvider === 'ollama' ? cfg.ollamaModel : cfg.defaultModel
      const out = await chat({
        provider: cfg.defaultProvider,
        model,
        messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
        temperature: 0,
        maxTokens: 8,
        ollamaBaseUrl: cfg.ollamaBaseUrl,
      })
      setStatus(`Success — ${PROVIDER_LABELS[cfg.defaultProvider]} responded: "${out.trim().slice(0, 40)}"`)
    } catch (e: any) {
      setStatus(`Test failed: ${String(e?.message ?? e).slice(0, 200)}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">AI models</h3>
        <p className="text-xs text-muted mt-1">
          Bring your own API key for OpenAI, Anthropic, Gemini, or OpenRouter — or run local models via Ollama.
          {' '}
          <span className="text-ink2">Tip: OpenRouter gives you one key for all major models (Claude, GPT, Gemini, Llama, DeepSeek, etc.) with a single bill.</span>
          {' '}
          {isElectron
            ? <span className="text-ink2">Keys are encrypted with your OS keychain (never stored in plaintext).</span>
            : <span className="text-warn">Browser dev mode: keys are session-only (cleared on refresh). Use the desktop app for persistent encrypted storage.</span>}
        </p>
      </div>

      <div className="grid gap-3">
        {PROVIDERS.filter(p => p !== 'ollama').map(p => (
          <ProviderKeyRow
            key={p}
            provider={p}
            hasKey={!!hasKey[p]}
            value={keys[p] ?? ''}
            onChange={v => setKeys(k => ({ ...k, [p]: v }))}
            onSave={() => saveKey(p)}
            onDelete={() => deleteKey(p)}
          />
        ))}
      </div>

      <div className="pt-3 border-t border-hairline space-y-2">
        <div className="text-xs font-semibold text-ink">Ollama (local models — no key)</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Base URL</label>
            <input className="input" value={cfg.ollamaBaseUrl}
              onChange={e => void save({ ollamaBaseUrl: e.target.value })}
              placeholder="http://127.0.0.1:11434" />
          </div>
          <div>
            <label className="label">Default local model</label>
            <input className="input" value={cfg.ollamaModel}
              onChange={e => void save({ ollamaModel: e.target.value })}
              placeholder="llama3.1" />
          </div>
        </div>
        <p className="text-[11px] text-muted">
          Install <span className="text-ink2">ollama</span> and pull a model with <span className="text-ink2">ollama pull llama3.1</span>.
          Then leave the URL at the default. Everything runs on your machine — nothing leaves.
        </p>
      </div>

      <div className="pt-3 border-t border-hairline space-y-2">
        <div className="text-xs font-semibold text-ink">Default model</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Provider</label>
            <select className="input" value={cfg.defaultProvider}
              onChange={e => {
                const p = e.target.value as AIProvider
                const first = modelsFor(p, cfg)[0]?.id ?? ''
                void save({ defaultProvider: p, defaultModel: p === 'ollama' ? cfg.ollamaModel : first })
              }}>
              {PROVIDERS.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            {cfg.defaultProvider === 'ollama' ? (
              <input className="input" value={cfg.ollamaModel}
                onChange={e => void save({ ollamaModel: e.target.value })} />
            ) : (
              <select className="input" value={cfg.defaultModel}
                onChange={e => void save({ defaultModel: e.target.value })}>
                {modelsFor(cfg.defaultProvider, cfg).map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs" onClick={testConnection} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {status && <span className="text-xs text-muted">{status}</span>}
        </div>
      </div>
    </div>
  )
}

function ProviderKeyRow({
  provider, hasKey, value, onChange, onSave, onDelete,
}: {
  provider: AIProvider
  hasKey: boolean
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onDelete: () => void
}) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="grid grid-cols-[140px_1fr_auto_auto] items-center gap-2">
      <div className="text-xs text-ink2">{PROVIDER_LABELS[provider]}</div>
      <input
        className="input"
        type={reveal ? 'text' : 'password'}
        placeholder={hasKey ? '••••••••••••  (stored — enter new value to replace)' : 'sk-... / API key'}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn-ghost text-xs" type="button" onClick={() => setReveal(r => !r)}>
        {reveal ? 'Hide' : 'Show'}
      </button>
      {value.trim()
        ? <button className="btn-primary text-xs" type="button" onClick={onSave}>Save</button>
        : hasKey
          ? <button className="btn-ghost text-xs !text-down" type="button" onClick={onDelete}>Remove</button>
          : <span className="text-[11px] text-muted px-2">not set</span>}
    </div>
  )
}
