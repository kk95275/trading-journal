import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type AIConversation } from '../db'
import { streamChat, PROVIDER_LABELS, type AIProvider } from '../lib/ai'
import { buildTradeContext, CHAT_SYSTEM_PROMPT } from '../lib/aiContext'
import { loadAIConfig, modelsFor, DEFAULT_AI_CONFIG, type AIConfig } from '../components/AISettingsCard'
import { Empty, PageHead } from '../components/ui'

type Msg = AIConversation['messages'][number]

export default function AIChat() {
  const conversations = useLiveQuery(
    () => db.aiConversations.orderBy('updatedAt').reverse().toArray(),
    [],
    [] as AIConversation[],
  )
  const [activeId, setActiveId] = useState<number | null>(null)
  const [cfg, setCfg] = useState<AIConfig>(DEFAULT_AI_CONFIG)
  const [provider, setProvider] = useState<AIProvider>('openai')
  const [model, setModel] = useState<string>('')
  const [attachTrades, setAttachTrades] = useState(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const active = conversations.find(c => c.id === activeId) ?? null

  useEffect(() => {
    void loadAIConfig().then(c => {
      setCfg(c)
      setProvider(c.defaultProvider)
      setModel(c.defaultProvider === 'ollama' ? c.ollamaModel : c.defaultModel)
    })
  }, [])

  // Auto-select the most recent conversation on first load.
  useEffect(() => {
    if (activeId == null && conversations.length > 0) setActiveId(conversations[0].id!)
  }, [conversations, activeId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [active?.messages.length, streamText])

  const modelOptions = useMemo(() => modelsFor(provider, cfg), [provider, cfg])

  const startNew = async () => {
    setActiveId(null)
    setStreamText('')
    setError('')
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    setError('')
    const now = Date.now()

    let convId = activeId
    let convo: AIConversation | undefined = active ?? undefined

    if (!convo) {
      const title = text.slice(0, 60)
      convId = await db.aiConversations.add({
        title,
        provider,
        model,
        createdAt: now,
        updatedAt: now,
        messages: [],
      })
      setActiveId(convId)
      convo = await db.aiConversations.get(convId!)
    }
    if (!convo || convId == null) return

    // Attach trade context on the FIRST turn if the toggle is on.
    let systemPrefix = CHAT_SYSTEM_PROMPT
    if (attachTrades && convo.messages.length === 0) {
      const [trades, setups, journal] = await Promise.all([
        db.trades.toArray(),
        db.setups.toArray(),
        db.journal.toArray(),
      ])
      const ctx = buildTradeContext(trades, setups, journal, { scope: 'the full trade history' })
      systemPrefix += `\n\n---\n${ctx.text}`
    }

    const userMsg: Msg = { role: 'user', content: text, ts: now }
    const nextMessages = [...convo.messages, userMsg]
    await db.aiConversations.update(convId, { messages: nextMessages, updatedAt: now })
    setInput('')
    setStreamText('')
    setStreaming(true)

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const wireMessages = [
        { role: 'system' as const, content: systemPrefix },
        ...nextMessages.map(m => ({ role: m.role, content: m.content })),
      ]
      let acc = ''
      await streamChat(
        {
          provider,
          model,
          messages: wireMessages,
          ollamaBaseUrl: cfg.ollamaBaseUrl,
        },
        d => { acc += d; setStreamText(acc) },
        abort.signal,
      )
      const finalMsg: Msg = { role: 'assistant', content: acc, ts: Date.now() }
      await db.aiConversations.update(convId, {
        messages: [...nextMessages, finalMsg],
        updatedAt: Date.now(),
      })
      setStreamText('')
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (!/abort/i.test(msg)) setError(msg)
      // Persist whatever partial text we got so it isn't lost.
      if (streamText) {
        const finalMsg: Msg = { role: 'assistant', content: streamText, ts: Date.now() }
        await db.aiConversations.update(convId, {
          messages: [...nextMessages, finalMsg],
          updatedAt: Date.now(),
        })
        setStreamText('')
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const deleteConvo = async (id: number) => {
    if (!confirm('Delete this conversation?')) return
    await db.aiConversations.delete(id)
    if (activeId === id) setActiveId(null)
  }

  return (
    <div className="pb-6">
      <PageHead
        title="AI Chat"
        sub="Ask about your trades, strategy, or anything trading-related"
        right={<button className="btn-primary text-xs" onClick={startNew}>+ New chat</button>}
      />
      <div className="px-6 grid grid-cols-[220px_1fr] gap-4" style={{ height: 'calc(100vh - 110px)' }}>
        {/* Conversation list */}
        <aside className="card !p-2 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="text-xs text-muted p-3">No chats yet.</div>
          ) : conversations.map(c => (
            <div key={c.id}
              className={`group flex items-start gap-2 px-2 py-2 rounded-md cursor-pointer text-xs ${
                activeId === c.id ? 'bg-accent/15 text-ink' : 'text-ink2 hover:bg-white/5'
              }`}
              onClick={() => setActiveId(c.id!)}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{c.title || 'Untitled'}</div>
                <div className="text-[10px] text-muted mt-0.5">{new Date(c.updatedAt).toLocaleDateString()}</div>
              </div>
              <button
                className="opacity-0 group-hover:opacity-100 text-muted hover:text-down text-sm px-1"
                onClick={e => { e.stopPropagation(); void deleteConvo(c.id!) }}
                title="Delete">×</button>
            </div>
          ))}
        </aside>

        {/* Chat */}
        <section className="card !p-0 flex flex-col overflow-hidden">
          {/* Header controls */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-hairline">
            <select className="input !w-auto !text-xs" value={provider}
              onChange={e => {
                const p = e.target.value as AIProvider
                setProvider(p)
                setModel(p === 'ollama' ? cfg.ollamaModel : (modelsFor(p, cfg)[0]?.id ?? ''))
              }}>
              {(['openai', 'anthropic', 'gemini', 'ollama'] as AIProvider[]).map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
            {provider === 'ollama' ? (
              <input className="input !w-auto !text-xs" value={model}
                onChange={e => setModel(e.target.value)} placeholder="llama3.1" />
            ) : (
              <select className="input !w-auto !text-xs" value={model} onChange={e => setModel(e.target.value)}>
                {modelOptions.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-ink2">
              <input type="checkbox" checked={attachTrades} onChange={e => setAttachTrades(e.target.checked)} />
              Attach my trade context {active && active.messages.length > 0 && <span className="text-muted">(next chat)</span>}
            </label>
          </div>

          {/* Message list */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {(!active || active.messages.length === 0) && !streaming ? (
              <Empty text="Start a conversation. Toggle “Attach my trade context” to have the coach see your trades." />
            ) : (
              <>
                {active?.messages.map((m, i) => <Bubble key={i} msg={m} />)}
                {streaming && <Bubble msg={{ role: 'assistant', content: streamText || '…', ts: Date.now() }} pending />}
              </>
            )}
            {error && <div className="text-xs text-down">{error}</div>}
          </div>

          {/* Composer */}
          <div className="border-t border-hairline p-3 space-y-2">
            <textarea
              className="input !text-sm resize-none w-full"
              rows={3}
              placeholder="Ask about your setups, mistakes, or anything trading… (Ctrl/⌘+Enter to send)"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
              }}
              disabled={streaming}
            />
            <div className="flex items-center justify-end gap-2">
              {streaming ? (
                <button className="btn-ghost text-xs" onClick={cancel}>Stop</button>
              ) : (
                <button className="btn-primary text-xs" onClick={() => void send()} disabled={!input.trim()}>Send</button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function Bubble({ msg, pending }: { msg: Msg; pending?: boolean }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
        isUser ? 'bg-accent/20 text-ink' : 'bg-white/5 text-ink2'
      } ${pending ? 'opacity-80' : ''}`}>
        {msg.content}
      </div>
    </div>
  )
}
