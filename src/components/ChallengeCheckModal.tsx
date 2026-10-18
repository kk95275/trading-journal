// "Would this session have passed?" — runs a saved session's trades back through
// a firm's rules and reports every stage at once.
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type BacktestSession } from '../db'
import { fmtDate, fmtUsd } from '../lib/gold'
import { RULE_SETS, ruleSetById, type RuleSet } from '../lib/propRules'
import { checkAllStages, tradesForSession, type StageVerdict } from '../replay/challengeCheck'
import { Modal } from './ui'

export default function ChallengeCheckModal({
  session,
  onClose,
}: {
  session: BacktestSession
  onClose: () => void
}) {
  // Default to the rule set the session already ran under, if it had one.
  const [ruleSetId, setRuleSetId] = useState(
    () => (session.rules && ruleSetById(session.rules.ruleSetId)?.id) ?? RULE_SETS[0].id,
  )
  const [verdicts, setVerdicts] = useState<StageVerdict[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const allTrades = useLiveQuery(
    () => db.trades.where('accountId').equals(session.accountId).toArray(),
    [session.accountId],
    undefined,
  )

  const rules = ruleSetById(ruleSetId)

  useEffect(() => {
    if (!allTrades || !rules) return
    let cancelled = false
    setRunning(true)
    setError('')
    setVerdicts(null)
    void (async () => {
      try {
        const picked = await tradesForSession(
          allTrades, session.id, session.accountId, session.startTs, session.resumeTs,
        )
        const out = await checkAllStages({
          trades: picked,
          sessionBalance: session.startingBalance,
          rules,
          spreadBySymbol: { [session.symbol]: session.spread },
        })
        if (!cancelled) setVerdicts(out)
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e))
      } finally {
        if (!cancelled) setRunning(false)
      }
    })()
    return () => { cancelled = true }
  }, [allTrades, rules, session])

  const scale = rules && session.startingBalance > 0 ? rules.accountSize / session.startingBalance : 1
  const used = verdicts?.[0]?.tradesUsed ?? 0

  return (
    <Modal title="Check against a challenge" onClose={onClose} wide>
      <div className="space-y-4">
        <div>
          <label className="label">Rules</label>
          <select className="input" value={ruleSetId} onChange={e => setRuleSetId(e.target.value)}>
            {RULE_SETS.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {rules && (
          <div className="text-[11px] text-muted leading-relaxed">
            {used} closed trade{used === 1 ? '' : 's'} from {session.accountName} · {session.symbol},
            taken on {fmtUsd(session.startingBalance, 0)} and
            {Math.abs(scale - 1) < 0.001
              ? ' judged at the same size.'
              : ` scaled ${scale.toFixed(2)}× to the ${fmtUsd(rules.accountSize, 0)} account.`}
            {' '}Equity is rebuilt minute by minute from the bar data, so floating losses count exactly as they would live.
          </div>
        )}

        {running && <div className="text-xs text-muted py-6 text-center">Replaying the trades…</div>}
        {error && <div className="text-xs text-down">{error}</div>}

        {verdicts && rules && (
          <div className="space-y-2">
            {verdicts.map(v => <VerdictRow key={v.stageId} v={v} rules={rules} />)}
          </div>
        )}
      </div>
    </Modal>
  )
}

function VerdictRow({ v, rules }: { v: StageVerdict; rules: RuleSet }) {
  if (v.error) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        <div className="text-xs font-semibold text-ink">{v.stageName}</div>
        <div className="text-[11px] text-warn mt-1">{v.error}</div>
      </div>
    )
  }

  // A funded stage has no target, so surviving the limits IS the pass.
  const survived = v.targetUsd === 0 && v.outcome === 'incomplete'
  const skin = survived
    ? { box: 'border-up/30 bg-up/5', text: 'text-up', label: '✓ Survived' }
    : {
      passed: { box: 'border-up/30 bg-up/5', text: 'text-up', label: '✓ Passed' },
      failed: { box: 'border-down/30 bg-down/5', text: 'text-down', label: '✕ Breached' },
      incomplete: { box: 'border-warn/30 bg-warn/5', text: 'text-warn', label: '— Target not reached' },
    }[v.outcome]
  const daysShort = v.tradingDays < v.minTradingDays

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${skin.box}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-ink">{v.stageName}</div>
        <div className={`text-xs font-semibold ${skin.text}`}>{skin.label}</div>
      </div>

      {v.outcome === 'failed' && v.breach && (
        <div className="text-[11px] text-ink2">
          <span className="text-down font-medium">{v.breach.title}</span> on {fmtDate(v.breach.time)} — {v.breach.detail}
        </div>
      )}
      {survived && (
        <div className="text-[11px] text-ink2">
          Never touched a limit, closing at {fmtUsd(v.profit)}. A funded account has no target —
          staying inside the limits is the whole job.
        </div>
      )}
      {v.outcome === 'incomplete' && !survived && (
        <div className="text-[11px] text-ink2">
          Survived every limit, but closed at {fmtUsd(v.profit)} of a {fmtUsd(v.targetUsd)} target
          {daysShort && ` and only traded ${v.tradingDays} of the ${v.minTradingDays} required ${v.minTradingDays === 1 ? 'day' : 'days'}`}.
        </div>
      )}
      {v.outcome === 'passed' && (
        <div className="text-[11px] text-ink2">
          Hit {fmtUsd(v.profit)} against a {fmtUsd(v.targetUsd)} target over {v.tradingDays} trading days,
          without touching a floor.
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <Stat label="Peak profit" value={fmtUsd(v.peakProfit, 0)} tone="up" />
        <Stat label="Worst drawdown" value={fmtUsd(v.worstDrawdown, 0)} tone="down" />
        <Stat
          label="Closest to daily"
          value={fmtUsd(v.dailyRoomLeft, 0)}
          tone={v.dailyRoomLeft < 0 ? 'down' : v.dailyRoomLeft < rules.accountSize * 0.01 ? 'warn' : 'none'}
        />
        <Stat
          label="Closest to max"
          value={fmtUsd(v.maxRoomLeft, 0)}
          tone={v.maxRoomLeft < 0 ? 'down' : v.maxRoomLeft < rules.accountSize * 0.02 ? 'warn' : 'none'}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'warn' | 'none' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-ink2'
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={`font-medium ${color}`}>{value}</div>
    </div>
  )
}
