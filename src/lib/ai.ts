// Thin multi-provider chat adapter. Every AI call in the app funnels through
// chat() / streamChat(). Runs in either the Electron main process (via IPC —
// no CORS, no key exposure to the renderer) or, in browser dev mode, direct
// fetch (some providers block CORS from the browser — Anthropic in particular
// requires the "dangerous browser access" opt-in header, which we set).
//
// Deliberately NOT using LangChain: each provider here is one small function.
// Bundle stays small, no framework version churn.

import { isElectron } from './platform'

export type AIProvider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama'

export interface AIModel {
  id: string        // provider-native model id sent on the wire
  label: string     // shown in the UI
  contextK?: number // approx context window in K tokens (hint only)
}

export const MODELS: Record<AIProvider, AIModel[]> = {
  openai: [
    { id: 'gpt-5',           label: 'GPT-5',           contextK: 400 },
    { id: 'gpt-5-mini',      label: 'GPT-5 mini',      contextK: 400 },
    { id: 'gpt-4o',          label: 'GPT-4o',          contextK: 128 },
    { id: 'gpt-4o-mini',     label: 'GPT-4o mini',     contextK: 128 },
    { id: 'o4-mini',         label: 'o4-mini (reasoning)', contextK: 200 },
  ],
  anthropic: [
    { id: 'claude-opus-4-5-20250929',     label: 'Claude Opus 4.5',   contextK: 200 },
    { id: 'claude-sonnet-4-5-20250929',   label: 'Claude Sonnet 4.5', contextK: 200 },
    { id: 'claude-haiku-4-5-20251001',    label: 'Claude Haiku 4.5',  contextK: 200 },
    { id: 'claude-3-5-sonnet-20241022',   label: 'Claude 3.5 Sonnet', contextK: 200 },
  ],
  gemini: [
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',   contextK: 1000 },
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash', contextK: 1000 },
    { id: 'gemini-1.5-pro',        label: 'Gemini 1.5 Pro',   contextK: 2000 },
    { id: 'gemini-1.5-flash',      label: 'Gemini 1.5 Flash', contextK: 1000 },
  ],
  openrouter: [
    // Curated top picks. OpenRouter has 300+ models — set a custom one via
    // the free-text input in the model picker if what you want isn't here.
    { id: 'anthropic/claude-opus-4.5',           label: 'Claude Opus 4.5',        contextK: 200 },
    { id: 'anthropic/claude-sonnet-4.5',         label: 'Claude Sonnet 4.5',      contextK: 200 },
    { id: 'anthropic/claude-haiku-4.5',          label: 'Claude Haiku 4.5',       contextK: 200 },
    { id: 'openai/gpt-5',                        label: 'GPT-5',                  contextK: 400 },
    { id: 'openai/gpt-5-mini',                   label: 'GPT-5 mini',             contextK: 400 },
    { id: 'openai/gpt-4o',                       label: 'GPT-4o',                 contextK: 128 },
    { id: 'google/gemini-2.5-pro',               label: 'Gemini 2.5 Pro',         contextK: 1000 },
    { id: 'google/gemini-2.5-flash',             label: 'Gemini 2.5 Flash',       contextK: 1000 },
    { id: 'deepseek/deepseek-r1',                label: 'DeepSeek R1 (reasoning)', contextK: 128 },
    { id: 'meta-llama/llama-3.3-70b-instruct',   label: 'Llama 3.3 70B',          contextK: 128 },
    { id: 'qwen/qwen-2.5-72b-instruct',          label: 'Qwen 2.5 72B',           contextK: 128 },
  ],
  ollama: [
    // Ollama models are installed locally — this list is a starting hint.
    // The Settings UI also allows typing any model name.
    { id: 'llama3.1',   label: 'Llama 3.1 (local)',  contextK: 128 },
    { id: 'llama3.2',   label: 'Llama 3.2 (local)',  contextK: 128 },
    { id: 'qwen2.5',    label: 'Qwen 2.5 (local)',   contextK: 128 },
    { id: 'mistral',    label: 'Mistral (local)',    contextK: 32 },
    { id: 'phi3',       label: 'Phi-3 (local)',      contextK: 128 },
  ],
}

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter (one key, all models)',
  ollama: 'Ollama (local)',
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  provider: AIProvider
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** Ollama only. Defaults to http://127.0.0.1:11434. */
  ollamaBaseUrl?: string
}

export interface ChatError extends Error { status?: number }

/** One-shot non-streaming. Returns the full assistant text. */
export async function chat(req: ChatRequest): Promise<string> {
  if (isElectron && window.electronAPI?.aiChat) {
    return window.electronAPI.aiChat(req)
  }
  return chatDirect(req)
}

/** Streaming. onDelta fires with each text chunk. Resolves with the final text. */
export async function streamChat(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (isElectron && window.electronAPI?.aiChatStream) {
    return window.electronAPI.aiChatStream(req, onDelta, signal)
  }
  return streamChatDirect(req, onDelta, signal)
}

// ─── Direct-fetch (browser dev) fallbacks ────────────────────────────────────
// The Electron path re-implements these in the main process; keep the wire
// format identical.

// Browser-dev-only: in Electron the key never leaves the main process.
async function loadKey(provider: AIProvider): Promise<string> {
  const k = memKeys[provider]
  if (!k) throw new Error(`No ${PROVIDER_LABELS[provider]} key set — add one in Settings.`)
  return k
}

async function chatDirect(req: ChatRequest): Promise<string> {
  let full = ''
  await streamChatDirect(req, d => { full += d })
  return full
}

async function streamChatDirect(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const key = req.provider === 'ollama' ? '' : await loadKey(req.provider)
  const built = buildRequest(req, key)
  const res = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.body, signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`${req.provider} ${res.status}: ${text.slice(0, 400)}`) as ChatError
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('No response body')
  return consumeStream(req.provider, res.body, onDelta)
}

/** In-memory key store for browser dev only. Cleared on refresh. */
const memKeys: Partial<Record<AIProvider, string>> = {}
export function setMemKey(provider: AIProvider, key: string) { memKeys[provider] = key }

// ─── Wire format ─────────────────────────────────────────────────────────────
// Exported so the Electron main process can reuse the exact same request
// builder and stream parser — keeps behaviour identical across runtimes.

export interface BuiltRequest { url: string; headers: Record<string, string>; body: string }

export function buildRequest(req: ChatRequest, key: string): BuiltRequest {
  const { provider, model, messages, temperature, maxTokens } = req
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    }
  }
  if (provider === 'openrouter') {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        // Optional OpenRouter attribution — makes the app show up in their
        // leaderboard/dashboard. Harmless to include.
        'http-referer': 'https://github.com/kk95275/trading-journal',
        'x-title': 'Trading Journal',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    }
  }
  if (provider === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const rest = messages.filter(m => m.role !== 'system')
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required for direct-from-browser calls. No-op in Node.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages: rest.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens ?? 4096,
        temperature,
        stream: true,
      }),
    }
  }
  if (provider === 'gemini') {
    // Gemini uses per-model URLs and a different body shape.
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    }
  }
  // ollama
  const base = (req.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  return {
    url: `${base}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature, num_predict: maxTokens },
    }),
  }
}

/** Consumes a streaming HTTP response body, calls onDelta with text chunks, returns final text. */
export async function consumeStream(
  provider: AIProvider,
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const delta = parseStreamLine(provider, line)
      if (delta) { out += delta; onDelta(delta) }
    }
  }
  // flush
  const tail = parseStreamLine(provider, buf)
  if (tail) { out += tail; onDelta(tail) }
  return out
}

function parseStreamLine(provider: AIProvider, raw: string): string | null {
  const line = raw.trim()
  if (!line) return null

  if (provider === 'ollama') {
    // ollama emits one JSON object per line (not SSE)
    try {
      const j = JSON.parse(line)
      return j.message?.content ?? null
    } catch { return null }
  }

  // OpenAI, Anthropic, Gemini all use SSE ("data: ...")
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null

  try {
    const j = JSON.parse(payload)
    if (provider === 'openai' || provider === 'openrouter') return j.choices?.[0]?.delta?.content ?? null
    if (provider === 'anthropic') {
      // content_block_delta events carry text under delta.text
      if (j.type === 'content_block_delta') return j.delta?.text ?? null
      return null
    }
    if (provider === 'gemini') {
      const parts = j.candidates?.[0]?.content?.parts
      if (Array.isArray(parts)) return parts.map((p: any) => p.text ?? '').join('')
      return null
    }
  } catch { /* partial SSE line — skip */ }
  return null
}
