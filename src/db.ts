import Dexie, { type Table } from 'dexie'
import type { Account, Trade, Setup, JournalEntry } from './lib/types'
import type { RuleOutcome, RuleRuntimeState, SessionRules } from './lib/propRules'

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

export interface StrategyFile {
  name: string           // e.g. 'main.py', 'utils.py'. .py extension enforced by UI.
  content: string
}

export interface StrategyDef {
  id?: number
  name: string
  /**
   * Deprecated single-file field, kept for backward compat with pre-1.8 records.
   * Use getStrategyFiles(def) — it migrates on read so the rest of the app only
   * sees the multi-file shape.
   */
  code?: string
  files?: StrategyFile[] // primary storage from v1.8 onward
  mainFile?: string      // name of the entry point; defaults to 'main.py'
  symbol: string         // default instrument to backtest against
  from?: number          // epoch seconds, inclusive; undefined = all available data
  to?: number
  spread: number
  commissionPerLot: number
  startingBalance: number
  createdAt: number
  updatedAt: number
}

/** Read shape: always returns non-empty files[] + a mainFile that exists in it. */
export function getStrategyFiles(def: StrategyDef): { files: StrategyFile[]; mainFile: string } {
  const raw = def.files && def.files.length ? def.files.slice() : []
  if (!raw.length) {
    raw.push({ name: 'main.py', content: def.code ?? '' })
  }
  const explicitMain = def.mainFile && raw.some(f => f.name === def.mainFile) ? def.mainFile : undefined
  const mainFile = explicitMain
    ?? (raw.find(f => f.name === 'main.py')?.name)
    ?? raw[0].name
  return { files: raw, mainFile }
}

/**
 * One saved replay session, kept so it can be picked up again later.
 *
 * Every backtest session gets a row, with or without a rule set: the in-memory
 * ReplayEngine dies with the page, and a trader shouldn't lose a week of replay
 * to a reload. `resumeTs` is the bar to restart on and `balance` is where the
 * account stood there.
 *
 * `rules` and `state` are present only for funded-challenge attempts — `state`
 * is the serialised RuleRuntime. A plain backtest leaves both null and simply
 * stays resumable forever.
 *
 * The store is still named `challengeAttempts` because it shipped under that
 * name in db v5; only the meaning widened.
 */
export interface BacktestSession {
  id?: number
  accountId: number
  accountName: string
  symbol: string
  spread: number
  commissionPerLot: number
  rules: SessionRules | null
  /** The session's opening balance — every rule limit is measured off this. */
  startingBalance: number
  /** Where the session originally began, for display. */
  startTs: number
  /** Replay timestamp to resume from — the bar the session was last on. */
  resumeTs: number
  /** Balance at resumeTs. Mirrors state.balance when there is a rule set. */
  balance: number
  state: RuleRuntimeState | null
  /** Mirrors state.outcome, or 'running' for a plain session that never ends. */
  outcome: RuleOutcome
  createdAt: number
  updatedAt: number
}

/** Pre-widening alias, so older imports keep reading sensibly. */
export type ChallengeAttempt = BacktestSession

class TradingJournalDB extends Dexie {
  accounts!: Table<Account, number>
  trades!: Table<Trade, number>
  setups!: Table<Setup, number>
  journal!: Table<JournalEntry, number>
  settings!: Table<SettingRow, string>
  aiConversations!: Table<AIConversation, number>
  customIndicators!: Table<CustomIndicatorDef, number>
  strategies!: Table<StrategyDef, number>
  challengeAttempts!: Table<BacktestSession, number>

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
    this.version(5).stores({
      challengeAttempts: '++id, accountId, outcome, updatedAt, [accountId+outcome]',
    })
    // Trades gained sessionId so a saved session's trades can be pulled back out
    // and replayed against a rule set. Trades written before this have none, and
    // fall back to matching on account plus the session's time span.
    this.version(6).stores({
      trades: '++id, accountId, entryTime, exitTime, setupId, symbol, direction, sessionId',
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
