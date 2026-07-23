import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { Empty, PageHead } from '../components/ui'

const MOODS = ['😖', '😕', '😐', '🙂', '😎']

export default function Journal() {
  const entries = useLiveQuery(() => db.journal.orderBy('date').reverse().toArray(), [], [])
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [mood, setMood] = useState(3)
  const [content, setContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)

  const save = async () => {
    if (!content.trim()) return
    if (editingId) {
      await db.journal.update(editingId, { date, mood, content })
    } else {
      const existing = await db.journal.where('date').equals(date).first()
      if (existing) await db.journal.update(existing.id!, { mood, content })
      else await db.journal.add({ date, mood, content })
    }
    setContent('')
    setEditingId(null)
  }

  const edit = (id: number) => {
    const e = entries?.find(x => x.id === id)
    if (!e) return
    setDate(e.date); setMood(e.mood); setContent(e.content); setEditingId(id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="pb-8">
      <PageHead title="Daily Journal" sub="Pre-market plans, post-session reviews, psychology notes" />
      <div className="px-6 space-y-4 max-w-3xl">
        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <input type="date" className="input !w-auto" value={date} onChange={e => setDate(e.target.value)} />
            <div className="flex gap-1">
              {MOODS.map((m, i) => (
                <button
                  key={i}
                  className={`text-xl px-1.5 py-0.5 rounded-lg transition-colors ${mood === i + 1 ? 'bg-accent/25' : 'hover:bg-white/5 opacity-50'}`}
                  title={`Discipline/mood ${i + 1}/5`}
                  onClick={() => setMood(i + 1)}
                >
                  {m}
                </button>
              ))}
            </div>
            {editingId && <span className="text-xs text-warn">editing existing entry</span>}
          </div>
          <textarea
            className="input min-h-[120px]"
            placeholder="What's the plan? What happened? What did you do well, what will you fix tomorrow?"
            value={content}
            onChange={e => setContent(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            {editingId && <button className="btn-ghost" onClick={() => { setEditingId(null); setContent('') }}>Cancel</button>}
            <button className="btn-primary" onClick={save} disabled={!content.trim()}>{editingId ? 'Update entry' : 'Save entry'}</button>
          </div>
        </div>
        {!entries?.length ? (
          <Empty text="No journal entries yet." />
        ) : (
          entries.map(e => (
            <div key={e.id} className="card">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-ink">{MOODS[e.mood - 1] ?? '😐'} {e.date}</div>
                <div className="flex gap-2">
                  <button className="btn-ghost text-xs" onClick={() => edit(e.id!)}>Edit</button>
                  <button className="btn-ghost text-xs !text-down" onClick={() => confirm('Delete this entry?') && db.journal.delete(e.id!)}>Delete</button>
                </div>
              </div>
              <p className="text-sm whitespace-pre-wrap">{e.content}</p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
