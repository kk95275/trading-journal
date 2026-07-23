// Folder sync: mirrors the browser database (IndexedDB) to
// trading-journal/data-journal/journal.json via the dev server, debounced
// after every change. On startup, if the browser database is empty but the
// folder has data (browser wiped, or a different browser), it auto-restores.
import { db } from '../db'
import type { Trade } from './types'

export interface SyncStatus {
  lastSavedAt: number | null
  saving: boolean
  restored: boolean
  error: string
}

export const syncStatus: SyncStatus = { lastSavedAt: null, saving: false, restored: false, error: '' }

const listeners = new Set<() => void>()
export function onSyncChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const emit = () => { for (const fn of listeners) fn() }

let timer: ReturnType<typeof setTimeout> | null = null
let suspended = false // true while restoring, so restore writes don't re-trigger a save
let initialized = false

const blobToB64 = (b: Blob) =>
  new Promise<string>(resolve => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsDataURL(b)
  })

const b64ToBlob = async (s: string) => (await fetch(s)).blob()

export async function buildSnapshot() {
  const trades = await Promise.all(
    (await db.trades.toArray()).map(async t => ({
      ...t,
      screenshot: t.screenshot ? await blobToB64(t.screenshot) : undefined,
    })),
  )
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: await db.accounts.toArray(),
    trades,
    setups: await db.setups.toArray(),
    journal: await db.journal.toArray(),
    settings: await db.settings.toArray(),
  }
}

export async function applySnapshot(p: any) {
  suspended = true
  try {
    await db.transaction('rw', db.accounts, db.trades, db.setups, db.journal, db.settings, async () => {
      await Promise.all([db.accounts.clear(), db.trades.clear(), db.setups.clear(), db.journal.clear(), db.settings.clear()])
      await db.accounts.bulkAdd(p.accounts ?? [])
      await db.setups.bulkAdd(p.setups ?? [])
      await db.journal.bulkAdd(p.journal ?? [])
      await db.settings.bulkAdd(p.settings ?? [])
    })
    for (const t of p.trades ?? []) {
      const { screenshot, ...rest } = t as Trade & { screenshot?: string }
      await db.trades.add({ ...rest, screenshot: screenshot ? await b64ToBlob(screenshot) : undefined })
    }
  } finally {
    suspended = false
  }
}

export async function syncNow() {
  if (suspended) return
  if (timer) { clearTimeout(timer); timer = null }
  syncStatus.saving = true
  emit()
  try {
    const snap = await buildSnapshot()
    const res = await fetch('/api/journal', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-journal-meta': JSON.stringify({ exportedAt: snap.exportedAt, trades: snap.trades.length, accounts: snap.accounts.length }),
      },
      body: JSON.stringify(snap),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
    syncStatus.lastSavedAt = Date.now()
    syncStatus.error = ''
  } catch (e: any) {
    syncStatus.error = String(e.message || e)
  }
  syncStatus.saving = false
  emit()
}

export function scheduleSync() {
  if (suspended) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void syncNow() }, 2500)
}

export async function initSync() {
  if (initialized) return
  initialized = true

  // auto-restore from the folder when the browser database is empty
  try {
    const counts = await Promise.all([db.trades.count(), db.accounts.count(), db.journal.count(), db.setups.count()])
    if (counts.every(c => c === 0)) {
      const res = await fetch('/api/journal')
      if (res.ok) {
        const p = await res.json()
        if (p && (p.trades?.length || p.accounts?.length || p.journal?.length || p.setups?.length)) {
          await applySnapshot(p)
          syncStatus.restored = true
          emit()
        }
      }
    }
  } catch { /* server storage unavailable — app still works from the browser db */ }

  // every table change schedules a folder save
  for (const table of [db.accounts, db.trades, db.setups, db.journal, db.settings]) {
    table.hook('creating', function () { scheduleSync() })
    table.hook('updating', function () { scheduleSync() })
    table.hook('deleting', function () { scheduleSync() })
  }

  // flush pending changes when the tab is hidden/closed (best effort)
  window.addEventListener('pagehide', () => { if (timer) void syncNow() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) void syncNow()
  })
}
