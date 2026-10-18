// UI for funded-challenge rule sets: the picker on the session setup screen, the
// saved-attempt list beside it, the live meters along the top of a running
// session, and the breach/pass banner.
// All of it reads from src/lib/propRules — nothing here knows about any one firm.
import { useState } from 'react'
import { fmtDateTime, fmtDuration, fmtUsd } from '../lib/gold'
import {
  RULE_SETS,
  ruleSetById,
  stageOf,
  type RuleSet,
  type RuleStageId,
  type RuleStatus,
  type SessionRules,
} from '../lib/propRules'
import { summarizeAttempt } from '../replay/attemptStore'
import type { ChallengeAttempt } from '../db'

/* ---------------- setup screen ---------------- */

export function RuleSetPicker({
  value,
  onChange,
}: {
  value: SessionRules | null
  onChange: (v: SessionRules | null) => void
}) {
  const [showNotes, setShowNotes] = useState(false)
  const rules = ruleSetById(value?.ruleSetId)
  const stage = rules && value ? stageOf(rules, value.stageId) : null

  const pick = (id: string) => {
    if (id === 'none') return onChange(null)
    const rs = ruleSetById(id)
    if (!rs) return onChange(null)
    onChange({ ruleSetId: rs.id, stageId: rs.stages[0].id, overrides: {} })
  }

  const setStage = (stageId: RuleStageId) => {
    if (!value) return
    // Stage-specific defaults live on the stage, so drop a drawdown override.
    onChange({ ...value, stageId, overrides: { ...value.overrides, maxDrawdownPct: undefined } })
  }

  return (
    <div>
      <label className="label">Rules</label>
      <select className="input" value={value?.ruleSetId ?? 'none'} onChange={e => pick(e.target.value)}>
        <option value="none">Normal backtesting — no rules</option>
        {RULE_SETS.map(r => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>

      {rules && value && stage && (
        <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5 space-y-2.5">
          <div className="flex gap-1.5">
            {rules.stages.map(s => (
              <button
                key={s.id}
                className={`tab flex-1 !py-1 !text-[11px] ${s.id === value.stageId ? 'tab-on' : 'tab-off'}`}
                onClick={() => setStage(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <RuleSummary rules={rules} value={value} />

          <RuleOverrideControls rules={rules} value={value} onChange={onChange} />

          {stage.notes && stage.notes.length > 0 && (
            <ul className="text-[11px] text-muted space-y-0.5">
              {stage.notes.map(n => <li key={n}>· {n}</li>)}
            </ul>
          )}

          <button
            type="button"
            className="text-[11px] text-muted hover:text-ink2 underline underline-offset-2"
            onClick={() => setShowNotes(v => !v)}
          >
            {showNotes ? 'Hide' : 'Show'} {rules.unsimulated.length} rules this simulator can't check
          </button>
          {showNotes && (
            <ul className="text-[11px] text-warn/90 space-y-0.5">
              {rules.unsimulated.map(n => <li key={n}>· {n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function RuleSummary({ rules, value }: { rules: RuleSet; value: SessionRules }) {
  const stage = stageOf(rules, value.stageId)
  const size = rules.accountSize
  const ddPct = value.overrides.maxDrawdownPct ?? stage.maxDrawdownPct
  const basis = value.overrides.dailyLossBasis ?? rules.dailyLossBasis
  const dailyUsd = size * rules.dailyLossPct / 100
  const rows: [string, string][] = [
    stage.profitTargetPct > 0
      ? ['Profit target', `${stage.profitTargetPct}% · ${fmtUsd(size * stage.profitTargetPct / 100, 0)}`]
      : ['Profit target', 'none'],
    ['Daily loss', `${rules.dailyLossPct}% · ${fmtUsd(dailyUsd, 0)}${basis === 'startOfDayEquity' ? ' of day-start' : ' fixed'}, off ${rules.dailyBaseline}`],
    ['Max drawdown', `${ddPct}% ${rules.maxDrawdownTrailing ? 'trailing' : 'static'} · floor ${fmtUsd(size * (1 - ddPct / 100), 0)}`],
    ['Min trading days', stage.minTradingDays ? String(stage.minTradingDays) : '—'],
    ['Margin cap', rules.marginExposureMaxPct ? `${rules.marginExposureMaxPct}% of equity` : 'none'],
    ['Commission', rules.commissionPerLot !== undefined
      ? `${fmtUsd(rules.commissionPerLot, 0)}/lot round-turn`
      : 'varies by instrument — yours'],
  ]
  return (
    <div className="space-y-1 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <span className="text-muted">{k}</span>
          <span className="text-ink2 text-right">{v}</span>
        </div>
      ))}
      <div className="flex justify-between gap-2">
        <span className="text-muted">Also enforced</span>
        <span className="text-ink2 text-right">
          {[
            !rules.allowHedging && 'no hedging',
            (stage.weekendFlat ?? rules.weekendFlat) && 'flat before Friday close',
            rules.softRiskPerIdeaPct && `${rules.softRiskPerIdeaPct}%/idea warning`,
          ].filter(Boolean).join(' · ') || 'nothing beyond the limits above'}
        </span>
      </div>
    </div>
  )
}

/**
 * The two numbers the firm's own pages disagree on or leave ambiguous, exposed
 * rather than silently assumed. Defaults are the stricter reading of each.
 */
function RuleOverrideControls({
  rules,
  value,
  onChange,
}: {
  rules: RuleSet
  value: SessionRules
  onChange: (v: SessionRules) => void
}) {
  const stage = stageOf(rules, value.stageId)
  const set = (o: Partial<SessionRules['overrides']>) =>
    onChange({ ...value, overrides: { ...value.overrides, ...o } })

  // Only offered where the firm's own sources actually conflict.
  const ddChoices = stage.maxDrawdownChoices ?? []
  const dd = value.overrides.maxDrawdownPct ?? stage.maxDrawdownPct
  const basis = value.overrides.dailyLossBasis ?? rules.dailyLossBasis
  if (ddChoices.length < 2 && !rules.dailyBasisAmbiguous) return null

  return (
    <div className="space-y-2 border-t border-hairline pt-2">
      {ddChoices.length > 1 && (
        <div>
          <div className="text-[11px] text-muted mb-1">
            {stage.name} max drawdown — {rules.firm}'s pages disagree
          </div>
          <div className="flex gap-1.5">
            {ddChoices.map(p => (
              <button
                key={p}
                className={`tab flex-1 !py-1 !text-[11px] ${dd === p ? 'tab-on' : 'tab-off'}`}
                onClick={() => set({ maxDrawdownPct: p })}
              >
                {p}% · floor {fmtUsd(rules.accountSize * (1 - p / 100), 0)}
              </button>
            ))}
          </div>
        </div>
      )}
      {rules.dailyBasisAmbiguous && (
      <div>
        <div className="text-[11px] text-muted mb-1">Daily loss is {rules.dailyLossPct}% of…</div>
        <div className="flex gap-1.5">
          <button
            className={`tab flex-1 !py-1 !text-[11px] ${basis === 'initialBalance' ? 'tab-on' : 'tab-off'}`}
            onClick={() => set({ dailyLossBasis: 'initialBalance' })}
          >
            starting balance (fixed {fmtUsd(rules.accountSize * rules.dailyLossPct / 100, 0)})
          </button>
          <button
            className={`tab flex-1 !py-1 !text-[11px] ${basis === 'startOfDayEquity' ? 'tab-on' : 'tab-off'}`}
            onClick={() => set({ dailyLossBasis: 'startOfDayEquity' })}
          >
            that day's starting equity
          </button>
        </div>
      </div>
      )}
    </div>
  )
}

/* ---------------- saved attempts ---------------- */

/**
 * A 2-step evaluation runs for weeks, so an attempt outlives the replay session
 * that started it: unfinished ones can be picked back up, finished ones are the
 * record of how the attempt went. Only sessions with a rule set appear here.
 */
export function AttemptsPanel({
  attempts,
  busy,
  hasData,
  onResume,
  onDelete,
}: {
  attempts: ChallengeAttempt[]
  busy: boolean
  /** An attempt can't resume without its instrument's converted bars. */
  hasData: (symbol: string) => boolean
  onResume: (a: ChallengeAttempt) => void
  onDelete: (a: ChallengeAttempt) => void
}) {
  const running = attempts.filter(a => a.outcome === 'running')
  const done = attempts.filter(a => a.outcome !== 'running')

  return (
    <div className="card w-full max-w-md space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">Challenge attempts</h2>
        <p className="text-[11px] text-muted mt-0.5">
          An attempt survives reloads. Resume one and the floors, trading-day count and balance carry over.
        </p>
      </div>

      {running.length > 0 && (
        <div className="space-y-2">
          <div className="label !mb-0">In progress</div>
          {running.map(a => (
            <RunningAttempt key={a.id} a={a} busy={busy} hasData={hasData} onResume={onResume} onDelete={onDelete} />
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <div className="label !mb-0">History</div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="th !px-0">Stage</th>
                <th className="th">Result</th>
                <th className="th text-right">Peak</th>
                <th className="th text-right">Worst DD</th>
                <th className="th text-right !px-0">Days</th>
              </tr>
            </thead>
            <tbody>
              {done.map(a => <FinishedAttempt key={a.id} a={a} onDelete={onDelete} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RunningAttempt({
  a,
  busy,
  hasData,
  onResume,
  onDelete,
}: {
  a: ChallengeAttempt
  busy: boolean
  hasData: (symbol: string) => boolean
  onResume: (a: ChallengeAttempt) => void
  onDelete: (a: ChallengeAttempt) => void
}) {
  const m = summarizeAttempt(a)
  const ready = m.known && hasData(a.symbol)
  const blocked = !m.known
    ? `${a.rules.ruleSetId} is no longer in the app, so this attempt can't be rebuilt.`
    : !hasData(a.symbol) ? `No converted ${a.symbol} data to replay.` : undefined

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink truncate">{m.ruleSetName}</div>
          <div className="text-[11px] text-muted">
            {m.stageName} · {a.symbol} · paused at {fmtDateTime(a.resumeTs)} GMT
          </div>
        </div>
        <button
          className="text-muted hover:text-down text-sm leading-none shrink-0"
          title="Discard this attempt"
          onClick={() => onDelete(a)}
        >×</button>
      </div>
      <div className="flex items-baseline gap-3 text-[11px]">
        <span className="text-ink2">{fmtUsd(a.state.balance, 0)}</span>
        <span className={m.profit > 0 ? 'text-up' : m.profit < 0 ? 'text-down' : 'text-muted'}>
          {m.profit > 0 ? '+' : ''}{fmtUsd(m.profit, 0)}
        </span>
        <span className="text-muted">{m.tradingDays} trading day{m.tradingDays === 1 ? '' : 's'}</span>
      </div>
      <button
        className="btn-ghost w-full text-xs disabled:opacity-40"
        disabled={busy || !ready}
        title={blocked}
        onClick={() => onResume(a)}
      >
        Resume
      </button>
      {blocked && <div className="text-[11px] text-warn">{blocked}</div>}
    </div>
  )
}

function FinishedAttempt({ a, onDelete }: { a: ChallengeAttempt; onDelete: (a: ChallengeAttempt) => void }) {
  const m = summarizeAttempt(a)
  const passed = a.outcome === 'passed'
  return (
    <>
      <tr>
        <td className="td !px-0 text-ink2" title={`${m.ruleSetName} · ${a.symbol} · started ${fmtDateTime(a.startTs)} GMT`}>
          {m.stageName}
        </td>
        <td className={`td font-medium ${passed ? 'text-up' : 'text-down'}`}>{passed ? '✓ Passed' : '✕ Failed'}</td>
        <td className="td text-right text-up">{fmtUsd(m.peakProfit, 0)}</td>
        <td className="td text-right text-down">{fmtUsd(m.worstDrawdown, 0)}</td>
        <td className="td text-right !px-0">
          <span className="text-ink2">{m.tradingDays}</span>
          <button
            className="ml-2 text-muted hover:text-down"
            title="Remove from history"
            onClick={() => onDelete(a)}
          >×</button>
        </td>
      </tr>
      {m.breachTitle && (
        <tr>
          <td className="td !px-0 !pt-0 !border-0 text-[11px] text-down" colSpan={5} title={m.breachDetail ?? undefined}>
            {m.breachTitle}
            {a.state.overridden && <span className="text-warn"> · kept trading for practice</span>}
          </td>
        </tr>
      )}
    </>
  )
}

/* ---------------- live session ---------------- */

function Meter({
  label,
  left,
  limit,
  detail,
  invert,
}: {
  label: string
  left: number
  limit: number
  detail: string
  /** true = the bar fills as you make progress; false = it drains as you lose room. */
  invert?: boolean
}) {
  // Both kinds fill by the same fraction — room left for a limit, progress for a target.
  const frac = limit > 0 ? Math.max(0, Math.min(1, left / limit)) : 0
  const tone = invert
    ? 'bg-up'
    : frac < 0.2 ? 'bg-down' : frac < 0.5 ? 'bg-warn' : 'bg-up'
  const text = invert
    ? 'text-ink'
    : frac < 0.2 ? 'text-down' : frac < 0.5 ? 'text-warn' : 'text-ink'
  return (
    <div className="min-w-[116px]" title={detail}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-muted uppercase tracking-wide">{label}</span>
        <span className={`text-[11px] font-medium ${text}`}>{fmtUsd(left, 0)}</span>
      </div>
      <div className="h-1 mt-1 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full ${tone} transition-[width]`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  )
}

export function RulesHud({ status }: { status: RuleStatus }) {
  const s = status
  const weekendSoon = s.secondsToWeekend !== null && s.secondsToWeekend < 6 * 3600
  const marginPct = s.marginLimit > 0 && isFinite(s.marginLimit) ? s.marginUsed / s.marginLimit : 0

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 border-b border-hairline bg-surface/40 overflow-x-auto">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] uppercase tracking-wide text-muted">{s.rules.firm}</span>
        <span className="tab tab-on !cursor-default !py-0.5 !text-[10px]">{s.stage.name}</span>
      </div>

      <Meter
        label="Daily left"
        left={s.dailyLeft}
        limit={s.dailyLimit}
        detail={`Floor ${fmtUsd(s.dailyFloor)} — day started at ${fmtUsd(s.dayStartEquity)}. Floating losses count.`}
      />
      <Meter
        label="Max DD left"
        left={s.maxLeft}
        limit={s.maxLimit}
        detail={`Static floor ${fmtUsd(s.maxFloor)} — never moves up with profit.`}
      />
      {s.targetUsd > 0 && (
        <Meter
          label="To target"
          left={s.profitUsd}
          limit={s.targetUsd}
          invert
          detail={`${fmtUsd(s.profitUsd)} of ${fmtUsd(s.targetUsd)} realized. ${fmtUsd(s.targetLeft)} to go.`}
        />
      )}

      <div className="shrink-0" title="Equity = balance + floating P&L. Every limit is measured on this.">
        <div className="text-[10px] text-muted uppercase tracking-wide">Equity</div>
        <div className="text-[11px] font-medium text-ink">{fmtUsd(s.equity, 0)}</div>
      </div>

      {s.minTradingDays > 0 && (
        <div className="shrink-0" title="Days on which you opened at least one trade, in server time.">
          <div className="text-[10px] text-muted uppercase tracking-wide">Days</div>
          <div className={`text-[11px] font-medium ${s.tradingDays >= s.minTradingDays ? 'text-up' : 'text-ink'}`}>
            {s.tradingDays}/{s.minTradingDays}
          </div>
        </div>
      )}

      {isFinite(s.marginLimit) && (
        <div className="shrink-0" title={`Margin in use ${fmtUsd(s.marginUsed)} of a ${fmtUsd(s.marginLimit)} cap. Over it is an instant breach.`}>
          <div className="text-[10px] text-muted uppercase tracking-wide">Margin</div>
          <div className={`text-[11px] font-medium ${marginPct > 0.9 ? 'text-down' : marginPct > 0.6 ? 'text-warn' : 'text-ink'}`}>
            {Math.round(marginPct * 100)}%
          </div>
        </div>
      )}

      {s.riskFlags > 0 && (
        <div className="shrink-0" title={`${s.riskFlags} trade(s) over the ${s.rules.softRiskPerIdeaPct}% per-idea guideline. Not a breach, but reviewable.`}>
          <div className="text-[10px] text-muted uppercase tracking-wide">Risk flags</div>
          <div className="text-[11px] font-medium text-warn">{s.riskFlags}</div>
        </div>
      )}

      {s.profitableDays > 0 && (
        <div className="shrink-0" title={`Days closing at or above +${s.rules.profitableDayPct}% — payouts count these.`}>
          <div className="text-[10px] text-muted uppercase tracking-wide">Profitable days</div>
          <div className="text-[11px] font-medium text-ink">{s.profitableDays}</div>
        </div>
      )}

      {weekendSoon && s.secondsToWeekend !== null && (
        <div className="shrink-0 text-[11px] text-warn" title="Positions must be flat before Friday close or the account breaches.">
          ⏳ flat in {fmtDuration(Math.max(0, s.secondsToWeekend))}
        </div>
      )}
    </div>
  )
}

export function RuleBanner({
  status,
  onOverride,
  onEnd,
}: {
  status: RuleStatus
  onOverride: () => void
  onEnd: () => void
}) {
  if (status.outcome === 'running') return null

  if (status.outcome === 'passed') {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-up/15 border-b border-up/30 text-sm">
        <span className="font-semibold text-up">✓ {status.stage.name} passed</span>
        <span className="text-xs text-ink2">
          {fmtUsd(status.profitUsd)} on a {fmtUsd(status.targetUsd)} target over {status.tradingDays} trading days.
        </span>
        <div className="flex-1" />
        <button className="btn-ghost text-xs" onClick={onEnd}>End session</button>
      </div>
    )
  }

  const b = status.breach
  return (
    <div className="flex items-start gap-3 px-4 py-2 bg-down/15 border-b border-down/30 text-sm">
      <div className="min-w-0">
        <div className="font-semibold text-down">
          ✕ {b?.title ?? 'Account breached'}
          {status.overridden && <span className="ml-2 text-xs font-normal text-warn">· continuing for practice, the run is still failed</span>}
        </div>
        {b && <div className="text-xs text-ink2 mt-0.5">{b.detail}</div>}
        <div className="text-xs text-muted mt-0.5">Open positions were closed at market, the way the firm would.</div>
      </div>
      <div className="flex-1" />
      <div className="flex gap-2 shrink-0">
        {!status.overridden && (
          <button
            className="btn-ghost text-xs"
            title="Keep trading this data for practice. The attempt stays marked as failed."
            onClick={onOverride}
          >
            Keep trading anyway
          </button>
        )}
        <button className="btn-ghost text-xs" onClick={onEnd}>End session</button>
      </div>
    </div>
  )
}
