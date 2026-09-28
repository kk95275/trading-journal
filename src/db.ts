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

export interface CustomIndicatorDef {
  id?: number
  name: string           // shown in the picker and the on-chart label
  code: string           // JS body — see src/replay/customEval.ts for the contract
  color: string          // default line color (each instance can override)
  overlay: boolean       // true for MVP — draws on the price chart
  createdAt: number
  updatedAt: number
}

export interface StrategyDef {
  id?: number
  name: string
  code: string           // Python source — see src/strategy/runner.ts contract
  symbol: string         // default instrument to backtest against
  from?: number          // epoch seconds, inclusive; undefined = all available data
  to?: number
  spread: number
  commissionPerLot: number
  startingBalance: number
  createdAt: number
  updatedAt: number
}

class TradingJournalDB extends Dexie {
  accounts!: Table<Account, number>
  trades!: Table<Trade, number>
  setups!: Table<Setup, number>
  journal!: Table<JournalEntry, number>
  settings!: Table<SettingRow, string>
  aiConversations!: Table<AIConversation, number>
  customIndicators!: Table<CustomIndicatorDef, number>
  strategies!: Table<StrategyDef, number>

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
    this.version(3).stores({
      customIndicators: '++id, name, updatedAt',
    })
    this.version(4).stores({
      strategies: '++id, name, symbol, updatedAt',
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
