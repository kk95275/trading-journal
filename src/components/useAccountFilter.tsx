import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { Trade } from '../lib/types'

/** Account dropdown + the trades that match it. */
export function useAccountFilter() {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], [])
  const [sel, setSel] = useState<number | 'all'>('all')
  const trades = useLiveQuery(
    () => (sel === 'all' ? db.trades.toArray() : db.trades.where('accountId').equals(sel).toArray()),
    [sel],
    [] as Trade[],
  )
  const element = useMemo(
    () => (
      <select className="input !w-auto" value={String(sel)} onChange={e => setSel(e.target.value === 'all' ? 'all' : +e.target.value)}>
        <option value="all">All accounts</option>
        {accounts?.map(a => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.kind})
          </option>
        ))}
      </select>
    ),
    [accounts, sel],
  )
  return { element, trades: trades ?? [], accounts: accounts ?? [], accountId: sel }
}
