// Turns a trade set + related metadata into a compact text prompt the model
// can reason over. The goal is to give the model enough shape (per-setup
// breakdown, session/time-of-day, mistake patterns, R distribution) to spot
// what's working and what isn't — without dumping every raw trade row.
//
// Size cap: aim for ~15KB of context by default. Full trade dumps only kick
// in below ~40 trades; above that we sample the extremes.

import type { Trade, Setup, JournalEntry } from './types'
import { summarize, bucketStats, sessionLabel, dayOfWeek, hourOfDay, type Summary } from './stats'
import { fmtUsd, fmtDateTime, fmtPct, fmtR } from './gold'

export interface TradeContextOptions {
  /** Include a per-trade table (default: capped by size). */
  maxSampleTrades?: number
  /** Header text describing what the caller wants analyzed. */
  scope?: string
}

export interface BuiltContext {
  text: string
  approxBytes: number
  tradeCount: number
}

const DEFAULT_MAX_SAMPLE = 30

export function buildTradeContext(
  trades: Trade[],
  setups: Setup[] = [],
  journal: JournalEntry[] = [],
  opts: TradeContextOptions = {},
): BuiltContext {
  const scope = opts.scope ?? 'the full trade history'
  const maxSample = opts.maxSampleTrades ?? DEFAULT_MAX_SAMPLE
  if (trades.length === 0) {
    const text = `# Trading Journal — ${scope}\n\nNo trades recorded yet.`
    return { text, approxBytes: text.length, tradeCount: 0 }
  }

  const s = summarize(trades)
  const setupById = new Map(setups.map(x => [x.id!, x]))

  const parts: string[] = []
  parts.push(`# Trading Journal Analysis Payload`)
  parts.push(`Scope: ${scope}. Total trades: ${trades.length}.`)
  parts.push('')
  parts.push(overallStatsBlock(s))
  parts.push('')
  parts.push(bucketBlock('By instrument', bucketStats(trades, t => t.symbol)))
  parts.push('')
  parts.push(bucketBlock('By setup', bucketStats(trades, t => setupById.get(t.setupId ?? -1)?.name ?? 'Ungrouped')))
  parts.push('')
  parts.push(bucketBlock('By session (UTC)', bucketStats(trades, t => sessionLabel(t.entryTime))))
  parts.push('')
  parts.push(bucketBlock('By day of week', bucketStats(trades, t => dayOfWeek(t.entryTime))))
  parts.push('')
  parts.push(bucketBlock('By hour of day (UTC)', bucketStats(trades, t => hourOfDay(t.entryTime))))
  parts.push('')
  parts.push(bucketBlock('By direction', bucketStats(trades, t => t.direction)))
  parts.push('')
  parts.push(bucketBlock('By grade', bucketStats(trades, t => t.grade ?? 'Ungraded')))
  parts.push('')
  parts.push(bucketBlock('By exit reason', bucketStats(trades, t => t.exitReason)))
  parts.push('')
  parts.push(mistakesBlock(trades))
  parts.push('')
  parts.push(setupsBlock(setups))
  parts.push('')
  parts.push(sampleTradesBlock(trades, setupById, maxSample))

  if (journal.length) {
    parts.push('')
    parts.push(journalBlock(journal))
  }

  const text = parts.filter(p => p !== null && p !== undefined).join('\n')
  return { text, approxBytes: text.length, tradeCount: trades.length }
}

function overallStatsBlock(s: Summary): string {
  return [
    '## Overall performance',
    `- Net P&L: ${fmtUsd(s.netPnl)} · Profit factor: ${isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} · Expectancy: ${fmtUsd(s.expectancy)}/trade`,
    `- Win rate: ${fmtPct(s.winRate)} (${s.wins}W / ${s.losses}L / ${s.breakeven}BE)`,
    `- Avg win: ${fmtUsd(s.avgWin)} · Avg loss: ${fmtUsd(s.avgLoss)} · Best: ${fmtUsd(s.bestTrade)} · Worst: ${fmtUsd(s.worstTrade)}`,
    `- Total R: ${fmtR(s.totalR)} · Avg R: ${fmtR(s.avgR)}`,
    `- Max drawdown: ${fmtUsd(s.maxDrawdown)}`,
    `- Streaks: current ${s.currentStreak >= 0 ? '+' : ''}${s.currentStreak} · max wins ${s.maxWinStreak} · max losses ${s.maxLossStreak}`,
    `- Per-trade Sharpe: ${s.sharpe.toFixed(2)}`,
  ].join('\n')
}

function bucketBlock(title: string, buckets: { key: string; n: number; pnl: number; winRate: number }[]): string {
  const rows = buckets
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 15)
    .map(b => `- ${b.key}: n=${b.n}, P&L ${fmtUsd(b.pnl)}, win ${fmtPct(b.winRate)}`)
  return `## ${title}\n${rows.join('\n') || '- (none)'}`
}

function mistakesBlock(trades: Trade[]): string {
  const counts = new Map<string, { n: number; pnl: number }>()
  for (const t of trades) {
    for (const m of t.mistakes ?? []) {
      const cur = counts.get(m) ?? { n: 0, pnl: 0 }
      cur.n++; cur.pnl += t.pnl
      counts.set(m, cur)
    }
  }
  if (counts.size === 0) return '## Mistake tags\n- (none logged)'
  const rows = [...counts.entries()]
    .sort((a, b) => a[1].pnl - b[1].pnl)
    .slice(0, 15)
    .map(([m, v]) => `- "${m}": ${v.n} trades, P&L ${fmtUsd(v.pnl)}`)
  return `## Mistake tags (most damaging first)\n${rows.join('\n')}`
}

function setupsBlock(setups: Setup[]): string {
  if (setups.length === 0) return '## Setups\n- (none defined)'
  const rows = setups.slice(0, 20).map(s => {
    const crit = (s.criteria ?? []).slice(0, 4).join('; ')
    return `- ${s.name}${s.description ? ` — ${s.description}` : ''}${crit ? ` [criteria: ${crit}]` : ''}`
  })
  return `## Setups defined\n${rows.join('\n')}`
}

function sampleTradesBlock(
  trades: Trade[],
  setupById: Map<number, Setup>,
  max: number,
): string {
  // Pick a mix: top winners, worst losers, most recent — so the model sees
  // both extremes and current form, not just a chronological head.
  const byPnl = [...trades].sort((a, b) => b.pnl - a.pnl)
  const byRecent = [...trades].sort((a, b) => b.exitTime - a.exitTime)
  const pickWinners = byPnl.slice(0, Math.max(2, Math.floor(max / 3)))
  const pickLosers = byPnl.slice(-Math.max(2, Math.floor(max / 3))).reverse()
  const pickRecent = byRecent.slice(0, max - pickWinners.length - pickLosers.length)
  const picked = dedupeById([...pickWinners, ...pickLosers, ...pickRecent]).slice(0, max)

  const rows = picked.map(t => {
    const setup = setupById.get(t.setupId ?? -1)?.name ?? '—'
    const mistakes = (t.mistakes ?? []).join(',') || '—'
    const conf = (t.confirmations ?? []).filter(c => c.checked).map(c => c.label).join(',') || '—'
    const notes = truncate((t.notes ?? '').replace(/\s+/g, ' '), 140)
    const post = truncate((t.postNotes ?? '').replace(/\s+/g, ' '), 100)
    return [
      `- ${fmtDateTime(t.entryTime)} ${t.symbol} ${t.direction}`,
      `x${t.lots}`,
      `pnl=${fmtUsd(t.pnl)}`,
      `R=${fmtR(t.rMultiple)}`,
      `exit=${t.exitReason}`,
      `grade=${t.grade ?? '-'}`,
      `setup="${setup}"`,
      `confirmations="${conf}"`,
      `mistakes="${mistakes}"`,
      notes ? `notes="${notes}"` : '',
      post ? `review="${post}"` : '',
    ].filter(Boolean).join(' ')
  })
  const suffix = trades.length > picked.length
    ? `\n(showing ${picked.length} of ${trades.length}: top winners + worst losers + most recent)`
    : ''
  return `## Sample trades${suffix}\n${rows.join('\n')}`
}

function journalBlock(entries: JournalEntry[]): string {
  const recent = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10)
  const rows = recent.map(e => {
    const bits = [
      `mood=${e.mood}/5`,
      e.marketBias ? `bias=${e.marketBias}` : '',
      e.grade ? `grade=${e.grade}` : '',
      e.keyLevels ? `levels="${truncate(e.keyLevels, 80)}"` : '',
      e.prePlan ? `plan="${truncate(e.prePlan, 120)}"` : '',
      e.postReview ? `review="${truncate(e.postReview, 120)}"` : '',
    ].filter(Boolean).join(' ')
    return `- ${e.date}: ${bits}`
  })
  return `## Journal entries (most recent 10)\n${rows.join('\n')}`
}

function dedupeById(ts: Trade[]): Trade[] {
  const seen = new Set<number>()
  const out: Trade[] = []
  for (const t of ts) {
    if (t.id === undefined || !seen.has(t.id)) {
      out.push(t)
      if (t.id !== undefined) seen.add(t.id)
    }
  }
  return out
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

export const ANALYSIS_SYSTEM_PROMPT =
  `You are an experienced trading coach analyzing a trader's journal and backtest results. ` +
  `Your job: identify what's working, what's not, and recommend the single most impactful ` +
  `strategy change the trader should make next.\n\n` +
  `Ground every claim in the numbers in the payload — cite the specific setup, session, ` +
  `hour, day-of-week, or mistake tag you're drawing from. Prefer edges backed by n ≥ 10 ` +
  `trades; call out low-sample findings as tentative. Do not invent trades or numbers.\n\n` +
  `Structure your response as:\n` +
  `1) **Edge** — where the trader is making money (setup/session/conditions, with numbers).\n` +
  `2) **Leaks** — where they're bleeding (specific mistake patterns, times, or setups).\n` +
  `3) **Best strategy to focus on** — one clear recommendation, actionable this week.\n` +
  `4) **What to stop doing** — one clear thing to cut.\n` +
  `5) **What to track next** — one metric or tag they should start capturing to sharpen the edge.\n\n` +
  `Be direct. Avoid hedged, generic advice.`

export const CHAT_SYSTEM_PROMPT =
  `You are an experienced trading coach embedded in a personal trading journal app. ` +
  `The user may attach their own trade history, backtest results, and journal entries as ` +
  `context — when they do, ground your answers in those numbers and cite specifics. ` +
  `When context is not attached, answer generally about trading, risk management, ` +
  `strategy, and psychology. Be direct and concise. Never invent trades or numbers.`
