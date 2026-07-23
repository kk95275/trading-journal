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
