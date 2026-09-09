import Dexie, { type Table } from 'dexie'
import type { Account, Trade, Setup, JournalEntry } from './lib/types'

export interface SettingRow {
  key: string
  value: unknown
}

export interface AIConversation {
  id?: number
  title: string
  provider: string
  model: string
  createdAt: number
  updatedAt: number
  // messages stored inline; a single conversation stays small enough that
  // splitting into a separate table isn't worth the extra query per read.
  messages: { role: 'user' | 'assistant' | 'system'; content: string; ts: number }[]
}

class TradingJournalDB extends Dexie {
  accounts!: Table<Account, number>
  trades!: Table<Trade, number>
  setups!: Table<Setup, number>
  journal!: Table<JournalEntry, number>
  settings!: Table<SettingRow, string>
  aiConversations!: Table<AIConversation, number>

  constructor() {
    super('trading-journal')
    this.version(1).stores({
      accounts: '++id, name, kind',
      trades: '++id, accountId, entryTime, exitTime, setupId, symbol, direction',
      setups: '++id, name',
      journal: '++id, date',
      settings: 'key',
    })
    this.version(2).stores({
      aiConversations: '++id, updatedAt',
    })
  }
}

export const db = new TradingJournalDB()

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row ? (row.value as T) : fallback
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value })
}
