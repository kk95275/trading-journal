import type { ReactNode } from 'react'
import { fmtUsd } from '../lib/gold'

export function PageHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between px-6 pt-5 pb-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

export function StatCard({ label, value, tone, hint }: { label: string; value: string; tone?: 'up' | 'down' | 'none'; hint?: string }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'
  return (
    <div className="card">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${color}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
    </div>
  )
}

export function PnlText({ v, digits = 2 }: { v: number; digits?: number }) {
  return <span className={v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-ink2'}>{v > 0 ? '+' : ''}{fmtUsd(v, digits)}</span>
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`bg-surface border border-white/10 rounded-xl shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[90vh] overflow-auto`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button className="text-muted hover:text-ink text-lg leading-none" onClick={onClose}>×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ text }: { text: string }) {
  return <div className="card text-center text-sm text-muted py-10">{text}</div>
}

const GRADE_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
  A: { bg: 'bg-up/15',     text: 'text-up',     label: 'A — Perfect'  },
  B: { bg: 'bg-accent/15', text: 'text-accent',  label: 'B — Good'     },
  C: { bg: 'bg-warn/15',   text: 'text-warn',    label: 'C — Average'  },
  D: { bg: 'bg-down/15',   text: 'text-down',    label: 'D — Poor'     },
}

export function GradeBadge({ grade, showLabel }: { grade: string; showLabel?: boolean }) {
  const c = GRADE_CONFIG[grade] ?? { bg: 'bg-white/5', text: 'text-muted', label: grade }
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold ${c.bg} ${c.text}`}>
      {showLabel ? c.label : grade}
    </span>
  )
}

export function GradePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1.5">
      {Object.entries(GRADE_CONFIG).map(([key, c]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(value === key ? '' : key)}
          className={`flex flex-col items-center px-3 py-1.5 rounded-lg border text-center transition-colors ${
            value === key ? 'border-accent/60 bg-accent/10' : 'border-hairline hover:border-white/25'
          }`}
        >
          <span className={`text-sm font-bold ${c.text}`}>{key}</span>
          <span className="text-[10px] text-muted leading-tight">{c.label.split(' — ')[1]}</span>
        </button>
      ))}
    </div>
  )
}

const EMOTIONS_BEFORE = ['Fearful', 'Anxious', 'Neutral', 'Confident', 'Overconfident']
const EMOTIONS_AFTER  = ['Angry', 'Disappointed', 'Neutral', 'Satisfied', 'Euphoric']

export function emotionLabel(v: number | undefined, type: 'before' | 'after'): string {
  if (!v) return '—'
  return (type === 'before' ? EMOTIONS_BEFORE : EMOTIONS_AFTER)[v - 1] ?? '—'
}

export function EmotionPicker({ value, onChange, type }: { value: number | undefined; onChange: (v: number | undefined) => void; type: 'before' | 'after' }) {
  const labels = type === 'before' ? EMOTIONS_BEFORE : EMOTIONS_AFTER
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(value === i + 1 ? undefined : i + 1)}
          className={`text-xs px-2 py-1 rounded-md border transition-colors ${
            value === i + 1
              ? 'border-accent/60 bg-accent/10 text-ink'
              : 'border-hairline text-muted hover:border-white/25 hover:text-ink2'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
