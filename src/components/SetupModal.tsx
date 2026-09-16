// Shared setup create/edit modal — used by the Playbook page and the Backtest
// OrderTicket's inline "+ New setup" button (so users don't have to leave a
// running replay session to define a fresh setup).

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { Setup } from '../lib/types'
import { Modal } from './ui'

export default function SetupModal({
  setup,
  onClose,
  onSaved,
}: {
  setup: Setup | null
  onClose: () => void
  /** Fires with the saved setup's id, so a caller can auto-select it. */
  onSaved?: (id: number) => void
}) {
  const [name, setName] = useState(setup?.name ?? '')
  const [description, setDescription] = useState(setup?.description ?? '')
  const [selected, setSelected] = useState<string[]>(setup?.criteria ?? [])
  const [newConf, setNewConf] = useState('')

  const allSetups = useLiveQuery(() => db.setups.toArray(), [], [])

  const allConfs = useMemo(() => {
    const seen = new Set<string>()
    for (const s of (allSetups ?? [])) {
      for (const c of s.criteria) seen.add(c)
    }
    for (const c of selected) seen.add(c)
    return [...seen]
  }, [allSetups, selected])

  const toggle = (c: string) =>
    setSelected(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])

  const addNew = () => {
    const trimmed = newConf.trim()
    if (!trimmed) return
    if (!selected.includes(trimmed)) setSelected(prev => [...prev, trimmed])
    setNewConf('')
  }

  const save = async () => {
    const rec = { name: name.trim(), description: description.trim(), criteria: selected }
    if (!rec.name) return
    if (setup?.id) {
      await db.setups.update(setup.id, rec)
      onSaved?.(setup.id)
    } else {
      const id = await db.setups.add(rec)
      onSaved?.(id as number)
    }
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
          <label className="label">Confirmation checklist</label>
          {allConfs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {allConfs.map(c => {
                const active = selected.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggle(c)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-[#3987e5] border-[#3987e5] text-white'
                        : 'bg-transparent border-grid text-muted hover:border-[#3987e5] hover:text-ink'
                    }`}
                  >
                    {active && <span className="mr-1">✓</span>}{c}
                  </button>
                )
              })}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Add new confirmation…"
              value={newConf}
              onChange={e => setNewConf(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNew() } }}
            />
            <button type="button" className="btn-ghost" onClick={addNew} disabled={!newConf.trim()}>Add</button>
          </div>
          {selected.length > 0 && (
            <p className="text-[11px] text-muted mt-1">{selected.length} confirmation{selected.length !== 1 ? 's' : ''} selected</p>
          )}
        </div>
        <div className="flex justify-between">
          {setup ? <button className="btn-ghost !text-down" onClick={del}>Delete</button> : <span />}
          <button className="btn-primary" onClick={save} disabled={!name.trim()}>Save setup</button>
        </div>
      </div>
    </Modal>
  )
}
