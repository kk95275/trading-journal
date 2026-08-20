export type Direction = 'long' | 'short'
export type AccountKind = 'backtest' | 'live' | 'paper'
export type ExitReason = 'sl' | 'tp' | 'manual' | 'other'
export type TradeGrade = 'A' | 'B' | 'C' | 'D'
export type MarketBias = 'bullish' | 'bearish' | 'neutral'

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
  postNotes?: string // post-trade review
  tags: string[]
  screenshot?: Blob
  // Psychology / quality
  grade?: TradeGrade     // A=perfect, B=good, C=average, D=poor execution
  emotionBefore?: number // 1=Fearful 2=Anxious 3=Neutral 4=Confident 5=Overconfident
  emotionAfter?: number  // 1=Angry 2=Disappointed 3=Neutral 4=Satisfied 5=Euphoric
}

export interface JournalEntry {
  id?: number
  date: string // YYYY-MM-DD
  mood: number // 1..5 discipline score
  content: string // kept for backward compat
  // Structured fields
  marketBias?: MarketBias
  keyLevels?: string
  prePlan?: string
  postReview?: string
  grade?: TradeGrade // session grade
}

export interface Bar {
  time: number // epoch seconds, GMT
  open: number
  high: number
  low: number
  close: number
  volume: number
}
