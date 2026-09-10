// Cross-window sync for the replay engine, so a pop-out window on a second
// monitor can show more charts of the same replay. Uses BroadcastChannel —
// works across BrowserWindows in Electron (same origin) and across tabs in
// browser dev, without any main-process plumbing.

import type { OpenPosition, SessionConfig } from './engine'
import type { Trade } from '../lib/types'
import type { Drawing } from './drawings'

/** What the mirror needs to render an up-to-date view of the replay. */
export interface EngineSnapshot {
  idx: number
  oneMinCount: number     // main's oneMin.length — mirror uses this to know if it needs to load more bars
  positions: OpenPosition[]
  sessionTrades: Trade[]
  drawings: Drawing[]
  ended: boolean
  loadingMore: boolean
  balance: number
}

export type SyncMessage =
  | { kind: 'hello'; config: SessionConfig; snapshot: EngineSnapshot }
  | { kind: 'tick'; snapshot: EngineSnapshot }
  | { kind: 'session-ended' }
  | { kind: 'request-hello' } // sent by a newly opened mirror to ask the primary to broadcast a hello

export const REPLAY_SYNC_CHANNEL = 'trading-journal-replay-sync'
export const REPLAY_SYNC_LOCALSTORAGE = 'trading-journal.replay.config'

export function openSyncChannel(): BroadcastChannel {
  return new BroadcastChannel(REPLAY_SYNC_CHANNEL)
}

/** Copy just the fields listed in EngineSnapshot from the live engine object. */
export function snapshotOf(engine: {
  idx: number
  oneMin: unknown[]
  positions: OpenPosition[]
  sessionTrades: Trade[]
  drawings: Drawing[]
  ended: boolean
  loadingMore: boolean
  balance: number
}): EngineSnapshot {
  return {
    idx: engine.idx,
    oneMinCount: engine.oneMin.length,
    // structuredClone would be safer for arrays of objects but BroadcastChannel
    // already deep-clones on send; a shallow copy here is enough to snapshot references.
    positions: engine.positions.slice(),
    sessionTrades: engine.sessionTrades.slice(),
    drawings: engine.drawings.slice(),
    ended: engine.ended,
    loadingMore: engine.loadingMore,
    balance: engine.balance,
  }
}
