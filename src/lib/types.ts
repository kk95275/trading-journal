export type Direction = 'long' | 'short'
export type AccountKind = 'backtest' | 'live' | 'paper'
export type ExitReason = 'sl' | 'tp' | 'manual' | 'other'

export interface Account {
  id?: number
  name: string
  kind: AccountKind
  startingBalance: number
  createdAt: number
}

export interface Setup {
  id?: number
  name: string
  description: string
  criteria: string[]
}

export interface Confirmation {
  label: string
  checked: boolean
}

export interface Trade {
  id?: number
  accountId: number
  symbol: string
  direction: Direction
  lots: number
  entryTime: number // epoch seconds, GMT
  exitTime: number
  entryPrice: number
  exitPrice: number
  sl?: number
  tp?: number
  pnl: number // net $, after fees
  fees: number
  riskAmount?: number
  rMultiple?: number
  exitReason: ExitReason
  setupId?: number
  confirmations: Confirmation[]
  mistakes: string[]
  notes: string
  tags: string[]
  screenshot?: Blob
}

export interface JournalEntry {
  id?: number
  date: string // YYYY-MM-DD
  mood: number // 1..5
  content: string
}

export interface Bar {
  time: number // epoch seconds, GMT
  open: number
  high: number
  low: number
  close: number
  volume: number
}
