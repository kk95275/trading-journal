import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { JournalEntry, MarketBias, TradeGrade } from '../lib/types'
import { Empty, GradeBadge, GradePicker, PageHead } from '../components/ui'

const MOODS = ['😖', '😕', '😐', '🙂', '😎']
const MOOD_LABELS = ['Undisciplined', 'Struggling', 'Neutral', 'Disciplined', 'Locked In']

const BIAS_CONFIG: { key: MarketBias; label: string; colorOn: string; colorOff: string }[] = [
  { key: 'bullish',  label: '▲ Bullish',  colorOn: 'bg-up/15 border-up/40 text-up',     colorOff: 'border-hairline text-muted hover:border-white/25' },
  { key: 'bearish',  label: '▼ Bearish',  colorOn: 'bg-down/15 border-down/40 text-down', colorOff: 'border-hairline text-muted hover:border-white/25' },
  { key: 'neutral',  label: '— Neutral',  colorOn: 'bg-warn/15 border-warn/40 text-warn', colorOff: 'border-hairline text-muted hover:border-white/25' },
]

export default function Journal() {
  const entries = useLiveQuery(() => db.journal.orderBy('date').reverse().toArray(), [], [])

  const todayStr = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(todayStr)
  const [marketBias, setMarketBias] = useState<MarketBias | ''>('')
  const [keyLevels, setKeyLevels] = useState('')
  const [prePlan, setPrePlan] = useState('')
  const [postReview, setPostReview] = useState('')
  const [grade, setGrade] = useState<TradeGrade | ''>('')
  const [mood, setMood] = useState(3)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)

  // Auto-load existing entry for the selected date
  useEffect(() => {
    const load = async () => {
      const existing = await db.journal.where('date').equals(date).first()
      if (existing) {
        setMarketBias(existing.marketBias ?? '')
        setKeyLevels(existing.keyLevels ?? '')
        setPrePlan(existing.prePlan ?? existing.content ?? '')
        setPostReview(existing.postReview ?? '')
        setGrade(existing.grade ?? '')
        setMood(existing.mood)
        setEditingId(existing.id ?? null)
      } else {
        setMarketBias('')
        setKeyLevels('')
        setPrePlan('')
        setPostReview('')
        setGrade('')
        setMood(3)
        setEditingId(null)
      }
    }
    void load()
  }, [date])

  const resetForm = () => {
    setMarketBias(''); setKeyLevels(''); setPrePlan(''); setPostReview('')
    setGrade(''); setMood(3); setEditingId(null)
  }

  const save = async () => {
    if (!prePlan.trim() && !postReview.trim()) return
    const data: Omit<JournalEntry, 'id'> = {
      date,
      mood,
      content: [prePlan, postReview].filter(Boolean).join('\n\n---\n\n'),
      marketBias: marketBias || undefined,
      keyLevels: keyLevels.trim() || undefined,
      prePlan: prePlan.trim() || undefined,
      postReview: postReview.trim() || undefined,
      grade: grade || undefined,
    }
    if (editingId) {
      await db.journal.update(editingId, data)
    } else {
      const existing = await db.journal.where('date').equals(date).first()
      if (existing) await db.journal.update(existing.id!, data)
      else await db.journal.add(data)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const loadForEdit = (e: JournalEntry) => {
    setDate(e.date)
    setMarketBias(e.marketBias ?? '')
    setKeyLevels(e.keyLevels ?? '')
    setPrePlan(e.prePlan ?? e.content ?? '')
    setPostReview(e.postReview ?? '')
    setGrade(e.grade ?? '')
    setMood(e.mood)
    setEditingId(e.id ?? null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const del = async (id: number) => {
    if (!confirm('Delete this journal entry?')) return
    await db.journal.delete(id)
    if (editingId === id) resetForm()
  }

  return (
    <div className="pb-10">
      <PageHead title="Daily Journal" sub="Pre-market plans, post-session reviews, and psychology tracking" />

      <div className="px-6 max-w-5xl space-y-4">
        {/* ── Editor card ── */}
        <div className="card space-y-4">
          {/* Row: date + bias selector */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="date"
              className="input !w-auto"
              value={date}
              onChange={e => setDate(e.target.value)}
            />
            <div className="flex gap-1.5">
              {BIAS_CONFIG.map(b => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setMarketBias(marketBias === b.key ? '' : b.key)}
                  className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                    marketBias === b.key ? b.colorOn : b.colorOff
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {editingId && (
              <span className="text-xs text-warn ml-auto">editing existing entry</span>
            )}
          </div>

          {/* Two-column body */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Pre-Market Plan */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">Pre-Market Plan</span>
                <div className="flex-1 h-px bg-hairline" />
              </div>
              <div>
                <label className="label">Key Levels</label>
                <input
                  className="input"
                  placeholder="e.g. 2650 resistance, 2620 support…"
                  value={keyLevels}
                  onChange={e => setKeyLevels(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Plan &amp; Market Context</label>
                <textarea
                  className="input min-h-[130px]"
                  placeholder="What's the setup today? What do you need to see before trading? Key events, bias rationale…"
                  value={prePlan}
                  onChange={e => setPrePlan(e.target.value)}
                />
              </div>
            </div>

            {/* Right: Post-Session Review */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-accent2 uppercase tracking-wider">Post-Session Review</span>
                <div className="flex-1 h-px bg-hairline" />
              </div>
              <div>
                <label className="label">Session Review</label>
                <textarea
                  className="input min-h-[130px]"
                  placeholder="What happened? Did you follow your plan? What went well, what to improve tomorrow?"
                  value={postReview}
                  onChange={e => setPostReview(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="label">Session Grade</label>
                  <GradePicker value={grade} onChange={v => setGrade(v as TradeGrade | '')} />
                </div>
                <div>
                  <label className="label">Discipline / Mindset</label>
                  <div className="flex gap-1">
                    {MOODS.map((m, i) => (
                      <button
                        key={i}
                        type="button"
                        title={MOOD_LABELS[i]}
                        className={`text-xl px-1.5 py-0.5 rounded-lg transition-colors ${
                          mood === i + 1 ? 'bg-accent/25' : 'hover:bg-white/5 opacity-40'
                        }`}
                        onClick={() => setMood(i + 1)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            {editingId && (
              <button className="btn-ghost" onClick={resetForm}>Cancel edit</button>
            )}
            <button
              className="btn-primary"
              onClick={save}
              disabled={!prePlan.trim() && !postReview.trim()}
            >
              {saved ? '✓ Saved' : editingId ? 'Update Entry' : 'Save Entry'}
            </button>
          </div>
        </div>

        {/* ── Past entries ── */}
        {!entries?.length ? (
          <Empty text="No journal entries yet. Write your first pre-market plan above." />
        ) : (
          <div className="space-y-3">
            {entries.map(e => (
              <EntryCard key={e.id} entry={e} onEdit={loadForEdit} onDelete={del} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Past entry card ── */

function EntryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry
  onEdit: (e: JournalEntry) => void
  onDelete: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasPlan = !!(entry.prePlan || entry.keyLevels)
  const hasReview = !!entry.postReview
  const legacyContent = !entry.prePlan && !entry.postReview ? entry.content : ''
  const bias = BIAS_CONFIG.find(b => b.key === entry.marketBias)

  return (
    <div className="card space-y-3">
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          className="text-sm font-semibold text-ink hover:text-accent transition-colors"
          onClick={() => setExpanded(x => !x)}
        >
          {entry.date}
        </button>
        {entry.grade && <GradeBadge grade={entry.grade} showLabel />}
        {bias && (
          <span className={`text-xs px-2 py-0.5 rounded border font-medium ${bias.colorOn}`}>
            {bias.label}
          </span>
        )}
        <span className="text-base" title={MOOD_LABELS[entry.mood - 1]}>{MOODS[entry.mood - 1] ?? '😐'}</span>
        {entry.keyLevels && (
          <span className="text-xs text-muted">Levels: {entry.keyLevels}</span>
        )}
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => setExpanded(x => !x)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button className="btn-ghost text-xs" onClick={() => onEdit(entry)}>Edit</button>
          <button className="btn-ghost text-xs !text-down" onClick={() => onDelete(entry.id!)}>Delete</button>
        </div>
      </div>

      {/* Body (collapsed = short preview) */}
      {expanded ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {hasPlan && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-accent uppercase tracking-wider">Pre-Market Plan</div>
              {entry.keyLevels && (
                <div className="text-xs text-muted">Key levels: {entry.keyLevels}</div>
              )}
              <p className="text-sm whitespace-pre-wrap text-ink2">{entry.prePlan}</p>
            </div>
          )}
          {hasReview && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-accent2 uppercase tracking-wider">Post-Session Review</div>
              <p className="text-sm whitespace-pre-wrap text-ink2">{entry.postReview}</p>
            </div>
          )}
          {legacyContent && (
            <div className="col-span-full">
              <p className="text-sm whitespace-pre-wrap text-ink2">{legacyContent}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted line-clamp-2">
          {entry.prePlan || entry.postReview || entry.content}
        </p>
      )}
    </div>
  )
}
