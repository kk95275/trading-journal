import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSetting, setSetting } from '../db'
import type { AccountKind } from '../lib/types'
import { fmtUsd } from '../lib/gold'
import { onSyncChange, syncNow, syncStatus } from '../lib/sync'
import { Modal, PageHead } from '../components/ui'

export default function Settings() {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], [])
  const tradeCounts = useLiveQuery(async () => {
    const counts = new Map<number, number>()
    for (const a of await db.accounts.toArray()) {
      counts.set(a.id!, await db.trades.where('accountId').equals(a.id!).count())
    }
    return counts
  }, [], new Map<number, number>())
  const [adding, setAdding] = useState(false)
  const [defaults, setDefaults] = useState({ spread: 0.3, commission: 6, balance: 10000 })
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getSetting('sessionDefaults', defaults).then(d => setDefaults({ ...defaults, ...(d as object) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveDefaults = async () => {
    await setSetting('sessionDefaults', defaults)
    setMsg('Defaults saved.')
    setTimeout(() => setMsg(''), 2000)
  }

  const deleteAccount = async (id: number, name: string) => {
    const n = tradeCounts.get(id) ?? 0
    if (!confirm(`Delete account “${name}” and its ${n} trades permanently?`)) return
    await db.trades.where('accountId').equals(id).delete()
    await db.accounts.delete(id)
  }

  const exportAll = async () => {
    setMsg('Building backup…')
    const toB64 = (blob: Blob) =>
      new Promise<string>(resolve => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.readAsDataURL(blob)
      })
    const trades = await Promise.all(
      (await db.trades.toArray()).map(async t => ({
        ...t,
        screenshot: t.screenshot ? await toB64(t.screenshot) : undefined,
      })),
    )
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: await db.accounts.toArray(),
      trades,
      setups: await db.setups.toArray(),
      journal: await db.journal.toArray(),
      settings: await db.settings.toArray(),
    }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `trading-journal-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setMsg('Backup downloaded.')
  }

  const importAll = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text())
      if (!payload.accounts || !payload.trades) throw new Error('Not a valid backup file')
      if (!confirm(`Replace ALL current data with this backup (${payload.trades.length} trades)? This cannot be undone.`)) return
      const fromB64 = async (s: string) => (await fetch(s)).blob()
      await db.transaction('rw', db.accounts, db.trades, db.setups, db.journal, db.settings, async () => {
        await Promise.all([db.accounts.clear(), db.trades.clear(), db.setups.clear(), db.journal.clear(), db.settings.clear()])
        await db.accounts.bulkAdd(payload.accounts)
        await db.setups.bulkAdd(payload.setups ?? [])
        await db.journal.bulkAdd(payload.journal ?? [])
        await db.settings.bulkAdd(payload.settings ?? [])
      })
      // screenshots outside the tx (fetch() is async and would close an idb tx)
      for (const t of payload.trades) {
        const { screenshot, ...rest } = t
        await db.trades.add({ ...rest, screenshot: screenshot ? await fromB64(screenshot) : undefined })
      }
      setMsg('Backup restored.')
    } catch (e: any) {
      setMsg('Import failed: ' + String(e.message || e))
    }
  }

  const wipe = async () => {
    if (!confirm('Delete ALL accounts, trades, setups and journal entries? This cannot be undone.')) return
    if (!confirm('Really sure? Last chance.')) return
    await Promise.all([db.accounts.clear(), db.trades.clear(), db.setups.clear(), db.journal.clear(), db.settings.clear()])
    setMsg('All data wiped.')
  }

  return (
    <div className="pb-8">
      <PageHead title="Settings" sub="Accounts, session defaults, backup" />
      <div className="px-6 space-y-4 max-w-3xl">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ink">Accounts</h3>
            <button className="btn-primary text-xs" onClick={() => setAdding(true)}>+ Add account</button>
          </div>
          {!accounts?.length ? (
            <div className="text-xs text-muted">No accounts yet — one is created automatically when you start a backtest.</div>
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Type</th><th className="th">Starting balance</th><th className="th">Trades</th><th className="th" /></tr></thead>
              <tbody>
                {accounts.map(a => (
                  <tr key={a.id}>
                    <td className="td text-ink">{a.name}</td>
                    <td className="td text-muted">{a.kind}</td>
                    <td className="td">{fmtUsd(a.startingBalance, 0)}</td>
                    <td className="td">{tradeCounts.get(a.id!) ?? 0}</td>
                    <td className="td text-right">
                      <button className="btn-ghost text-xs !text-down" onClick={() => deleteAccount(a.id!, a.name)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card space-y-3">
          <h3 className="text-sm font-semibold text-ink">Backtest session defaults</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Spread ($)</label>
              <input type="number" step="0.05" className="input" value={defaults.spread} onChange={e => setDefaults(d => ({ ...d, spread: +e.target.value }))} />
            </div>
            <div>
              <label className="label">Commission per lot ($, round-turn)</label>
              <input type="number" step="0.5" className="input" value={defaults.commission} onChange={e => setDefaults(d => ({ ...d, commission: +e.target.value }))} />
            </div>
            <div>
              <label className="label">Starting balance ($)</label>
              <input type="number" step="100" className="input" value={defaults.balance} onChange={e => setDefaults(d => ({ ...d, balance: +e.target.value }))} />
            </div>
          </div>
          <button className="btn-primary" onClick={saveDefaults}>Save defaults</button>
        </div>

        <SyncCard />

        <div className="card space-y-3">
          <h3 className="text-sm font-semibold text-ink">Manual backup</h3>
          <p className="text-xs text-muted">On top of the automatic folder sync above, you can export/restore everything (accounts, trades with screenshots, setups, journal) as a single JSON file — e.g. to move to another computer.</p>
          <div className="flex gap-2 items-center">
            <button className="btn-primary" onClick={exportAll}>Export backup</button>
            <label className="btn-ghost cursor-pointer">
              Restore backup…
              <input type="file" accept=".json" className="hidden" onChange={e => e.target.files?.[0] && importAll(e.target.files[0])} />
            </label>
          </div>
        </div>

        <div className="card space-y-2">
          <h3 className="text-sm font-semibold text-down">Danger zone</h3>
          <button className="btn-ghost !text-down" onClick={wipe}>Wipe all data</button>
        </div>

        {msg && <div className="text-xs text-warn">{msg}</div>}
        <p className="text-[11px] text-muted">Datasets: XAUUSD · EURUSD · GBPUSD — 1-min · 2003-05 → 2026-03 · GMT (no DST) · bid prices · see DATA-NOTES.txt</p>
      </div>
      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </div>
  )
}

function SyncCard() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const unsub = onSyncChange(() => setTick(t => t + 1))
    const id = setInterval(() => setTick(t => t + 1), 5000) // refresh the "x min ago" label
    return () => { unsub(); clearInterval(id) }
  }, [])
  const s = syncStatus
  const ago = s.lastSavedAt ? Math.round((Date.now() - s.lastSavedAt) / 1000) : null
  return (
    <div className="card space-y-2">
      <h3 className="text-sm font-semibold text-ink">Folder sync (automatic)</h3>
      <p className="text-xs text-muted">
        Every change is saved to <span className="text-ink2">trading-journal/data-journal/journal.json</span> (plus a daily copy, last 14 kept).
        If the browser's storage is ever empty — cleared data or a different browser — the app restores from that file on startup.
      </p>
      <div className="flex items-center gap-3 text-xs">
        <span className={s.error ? 'text-down' : 'text-up'}>
          {s.saving ? '● saving…'
            : s.error ? `● error: ${s.error}`
            : s.lastSavedAt ? `● saved ${ago! < 5 ? 'just now' : ago! < 120 ? `${ago}s ago` : `${Math.round(ago! / 60)}m ago`}`
            : '● will save after your first change'}
        </span>
        {s.restored && <span className="text-warn">restored from folder on startup</span>}
        <button className="btn-ghost text-xs ml-auto" onClick={() => void syncNow()}>Save to folder now</button>
      </div>
    </div>
  )
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AccountKind>('backtest')
  const [balance, setBalance] = useState(10000)
  const save = async () => {
    if (!name.trim()) return
    await db.accounts.add({ name: name.trim(), kind, startingBalance: balance, createdAt: Date.now() })
    onClose()
  }
  return (
    <Modal title="Add account" onClose={onClose}>
      <div className="space-y-3">
        <div><label className="label">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Live FTMO 10k" /></div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={kind} onChange={e => setKind(e.target.value as AccountKind)}>
            <option value="backtest">Backtest</option><option value="paper">Paper</option><option value="live">Live</option>
          </select>
        </div>
        <div><label className="label">Starting balance ($)</label><input type="number" className="input" value={balance} onChange={e => setBalance(+e.target.value)} /></div>
        <button className="btn-primary w-full" onClick={save} disabled={!name.trim()}>Create account</button>
      </div>
    </Modal>
  )
}
