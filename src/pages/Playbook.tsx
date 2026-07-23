import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { Setup } from '../lib/types'
import { fmtPct, fmtUsd } from '../lib/gold'
import { Empty, Modal, PageHead, PnlText } from '../components/ui'
import { useAccountFilter } from '../components/useAccountFilter'

export default function Playbook() {
  const { element: accountSelect, trades } = useAccountFilter()
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])
  const [editing, setEditing] = useState<Setup | 'new' | null>(null)

  const statsFor = (id?: number) => {
    const ts = trades.filter(t => t.setupId === id)
    const wins = ts.filter(t => t.pnl > 0).length
    const pnl = ts.reduce((s, t) => s + t.pnl, 0)
    const rs = ts.filter(t => t.rMultiple !== undefined)
    const avgR = rs.length ? rs.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / rs.length : 0
    // edge of discipline: trades where every confirmation was checked
    const withConf = ts.filter(t => t.confirmations.length > 0)
    const full = withConf.filter(t => t.confirmations.every(c => c.checked))
    const fullWr = full.length ? full.filter(t => t.pnl > 0).length / full.length : null
    const partial = withConf.filter(t => !t.confirmations.every(c => c.checked))
    const partialWr = partial.length ? partial.filter(t => t.pnl > 0).length / partial.length : null
    return { n: ts.length, winRate: ts.length ? wins / ts.length : 0, pnl, avgR, fullWr, fullN: full.length, partialWr, partialN: partial.length }
  }

  const mistakes = useMemo(() => {
    const m = new Map<string, { n: number; pnl: number }>()
    for (const t of trades) {
      for (const tag of t.mistakes) {
        const cur = m.get(tag) ?? { n: 0, pnl: 0 }
        cur.n++
        cur.pnl += t.pnl
        m.set(tag, cur)
      }
    }
    return [...m.entries()].sort((a, b) => a[1].pnl - b[1].pnl)
  }, [trades])

  return (
    <div className="pb-8">
      <PageHead
        title="Playbook"
        sub="Define your setups and their confirmation checklists — the Backtest order ticket uses them"
        right={<div className="flex gap-2">{accountSelect}<button className="btn-primary" onClick={() => setEditing('new')}>+ New setup</button></div>}
      />
      <div className="px-6 space-y-4">
        {!setups?.length ? (
          <Empty text="No setups yet. Create your first setup — e.g. “London sweep + FVG” with its confirmation checklist." />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {setups.map(s => {
              const st = statsFor(s.id)
              return (
                <div key={s.id} className="card">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">{s.name}</h3>
                      {s.description && <p className="text-xs text-muted mt-0.5">{s.description}</p>}
                    </div>
                    <button className="btn-ghost text-xs" onClick={() => setEditing(s)}>Edit</button>
                  </div>
                  {s.criteria.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {s.criteria.map(c => <li key={c} className="text-xs text-ink2">• {c}</li>)}
                    </ul>
                  )}
                  <div className="mt-3 pt-3 border-t border-grid grid grid-cols-4 gap-2 text-center">
                    <MiniStat label="Trades" value={String(st.n)} />
                    <MiniStat label="Win rate" value={st.n ? fmtPct(st.winRate) : '—'} />
                    <MiniStat label="Avg R" value={st.n ? `${st.avgR >= 0 ? '+' : ''}${st.avgR.toFixed(2)}` : '—'} />
                    <div>
                      <div className="text-[11px] text-muted">Net P&L</div>
                      <div className="text-sm font-semibold"><PnlText v={+st.pnl.toFixed(2)} digits={0} /></div>
                    </div>
                  </div>
                  {(st.fullWr !== null || st.partialWr !== null) && (
                    <div className="mt-2 text-[11px] text-muted">
                      Fully confirmed: {st.fullWr !== null ? `${fmtPct(st.fullWr)} WR (${st.fullN})` : '—'} · Partially: {st.partialWr !== null ? `${fmtPct(st.partialWr)} WR (${st.partialN})` : '—'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="card">
          <h3 className="text-sm font-semibold text-ink mb-1">What mistakes cost you</h3>
          <p className="text-xs text-muted mb-3">Tag mistakes on trades (Trades page → open a trade) and the damage shows up here.</p>
          {!mistakes.length ? (
            <div className="text-xs text-muted">No mistakes tagged yet — either you're perfect, or you're not tagging. 😉</div>
          ) : (
            <table className="w-full max-w-lg">
              <thead><tr><th className="th">Mistake</th><th className="th">Times</th><th className="th text-right">P&L on those trades</th></tr></thead>
              <tbody>
                {mistakes.map(([tag, m]) => (
                  <tr key={tag}>
                    <td className="td text-ink">{tag}</td>
                    <td className="td">{m.n}</td>
                    <td className={`td text-right font-medium ${m.pnl >= 0 ? 'text-up' : 'text-down'}`}>{m.pnl > 0 ? '+' : ''}{fmtUsd(m.pnl, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {editing && <SetupModal setup={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-sm font-semibold text-ink">{value}</div>
    </div>
  )
}

function SetupModal({ setup, onClose }: { setup: Setup | null; onClose: () => void }) {
  const [name, setName] = useState(setup?.name ?? '')
  const [description, setDescription] = useState(setup?.description ?? '')
  const [criteria, setCriteria] = useState(setup?.criteria.join('\n') ?? '')

  const save = async () => {
    const rec = { name: name.trim(), description: description.trim(), criteria: criteria.split('\n').map(s => s.trim()).filter(Boolean) }
    if (!rec.name) return
    if (setup?.id) await db.setups.update(setup.id, rec)
    else await db.setups.add(rec)
    onClose()
  }

  const del = async () => {
    if (!setup?.id) return
    if (!confirm('Delete this setup? Trades keep their data but lose the setup link.')) return
    await db.setups.delete(setup.id)
    onClose()
  }

  return (
    <Modal title={setup ? 'Edit setup' : 'New setup'} onClose={onClose}>
      <div className="space-y-3">
        <div><label className="label">Name</label><input className="input" placeholder="e.g. London sweep reversal" value={name} onChange={e => setName(e.target.value)} /></div>
        <div><label className="label">Description</label><input className="input" placeholder="One-liner about when this setup applies" value={description} onChange={e => setDescription(e.target.value)} /></div>
        <div>
          <label className="label">Confirmation checklist — one per line</label>
          <textarea className="input min-h-[120px]" placeholder={'Liquidity swept\n15m structure break\nFVG present\nEntry during London or NY'} value={criteria} onChange={e => setCriteria(e.target.value)} />
        </div>
        <div className="flex justify-between">
          {setup ? <button className="btn-ghost !text-down" onClick={del}>Delete</button> : <span />}
          <button className="btn-primary" onClick={save} disabled={!name.trim()}>Save setup</button>
        </div>
      </div>
    </Modal>
  )
}
