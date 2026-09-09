import { useMemo } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fmtDuration, fmtPct, fmtUsd } from '../lib/gold'
import { bucketStats, sessionLabel, summarize } from '../lib/stats'
import { Empty, GradeBadge, PageHead, StatCard, emotionLabel } from '../components/ui'
import { useAccountFilter } from '../components/useAccountFilter'
import AnalyzeButton from '../components/AnalyzeButton'

const INK_MUTED = '#898781'
const GRID_COLOR = '#2c2c2a'
const UP   = '#0ca30c'
const DOWN = '#d03b3b'

const GRADE_COLORS: Record<string, string> = {
  A: '#0ca30c', B: '#3987e5', C: '#fab219', D: '#d03b3b', Ungraded: '#898781',
}

const tooltipStyle = {
  contentStyle: { background: '#222221', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#c3c2b7' },
  itemStyle: { color: '#ffffff' },
}

const EMOTION_BEFORE_LABELS = ['', 'Fearful', 'Anxious', 'Neutral', 'Confident', 'Overconfident']
const EMOTION_BEFORE_ORDER  = ['Fearful', 'Anxious', 'Neutral', 'Confident', 'Overconfident']
const SESSION_ORDER = ['Asian', 'London', 'New York', 'Off-hours']
const GRADE_ORDER   = ['A', 'B', 'C', 'D', 'Ungraded']

export default function Analytics() {
  const { element: accountSelect, trades } = useAccountFilter()
  const s = useMemo(() => summarize(trades), [trades])

  const byInstrument = useMemo(
    () => bucketStats(trades, t => t.symbol).sort((a, b) => b.pnl - a.pnl),
    [trades],
  )

  const bySession = useMemo(() => {
    const m = new Map(bucketStats(trades, t => sessionLabel(t.entryTime)).map(b => [b.key, b]))
    return SESSION_ORDER.map(k => m.get(k) ?? { key: k, n: 0, pnl: 0, winRate: 0 })
  }, [trades])

  const byGrade = useMemo(() => {
    const m = new Map(bucketStats(trades, t => t.grade ?? 'Ungraded').map(b => [b.key, b]))
    return GRADE_ORDER.map(k => m.get(k)).filter((b): b is NonNullable<typeof b> => !!b && b.n > 0)
  }, [trades])

  const byEmotionBefore = useMemo(() => {
    const emotioned = trades.filter(t => t.emotionBefore !== undefined)
    if (!emotioned.length) return []
    const m = new Map(
      bucketStats(emotioned, t => EMOTION_BEFORE_LABELS[t.emotionBefore!] ?? 'Unknown').map(b => [b.key, b]),
    )
    return EMOTION_BEFORE_ORDER.map(k => m.get(k)).filter((b): b is NonNullable<typeof b> => !!b && b.n > 0)
  }, [trades])

  const riskStats = useMemo(() => {
    const withRisk = trades.filter(t => t.rMultiple !== undefined)
    const avgRr = withRisk.length
      ? (withRisk.reduce((s, t) => s + (t.rMultiple! > 0 ? t.rMultiple! : 0), 0) /
         withRisk.filter(t => t.pnl > 0).length || 0)
      : 0
    return {
      pctWithRisk: trades.length ? withRisk.length / trades.length : 0,
      avgWinR: isFinite(avgRr) ? avgRr : 0,
    }
  }, [trades])

  const bestSession = useMemo(
    () => [...bySession].filter(b => b.n > 0).sort((a, b) => b.pnl - a.pnl)[0],
    [bySession],
  )
  const bestInstrument = byInstrument[0]

  return (
    <div className="pb-8">
      <PageHead
        title="Analytics"
        sub="Performance breakdowns by instrument, session, trade quality and psychology"
        right={
          <div className="flex items-center gap-2">
            {accountSelect}
            <AnalyzeButton trades={trades} scope="analytics view" />
          </div>
        }
      />

      {!trades.length ? (
        <div className="px-6"><Empty text="No trades yet — add some trades to see your analytics." /></div>
      ) : (
        <div className="px-6 space-y-4">

          {/* ── Top stat row ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Sharpe ratio"
              value={isFinite(s.sharpe) ? s.sharpe.toFixed(2) : '—'}
              tone={s.sharpe > 1 ? 'up' : s.sharpe < 0 ? 'down' : 'none'}
              hint="per-trade · higher = better risk-adj. return"
            />
            <StatCard
              label="Best instrument"
              value={bestInstrument?.key ?? '—'}
              tone="up"
              hint={bestInstrument ? `${fmtPct(bestInstrument.winRate)} win · ${fmtUsd(bestInstrument.pnl, 0)}` : ''}
            />
            <StatCard
              label="Best session"
              value={bestSession?.key ?? '—'}
              tone="up"
              hint={bestSession ? `${fmtPct(bestSession.winRate)} win · ${fmtUsd(bestSession.pnl, 0)}` : ''}
            />
            <StatCard
              label="Avg hold time"
              value={fmtDuration(s.avgDurationSec)}
              hint={`${fmtPct(riskStats.pctWithRisk)} trades with defined risk`}
            />
          </div>

          {/* ── By Instrument ── */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="card lg:col-span-3">
              <h3 className="text-sm font-semibold text-ink mb-3">P&amp;L by Instrument</h3>
              <div className="h-52">
                <ResponsiveContainer>
                  <BarChart data={byInstrument} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                    <XAxis dataKey="key" stroke={INK_MUTED} tickLine={false} fontSize={11} />
                    <YAxis stroke={INK_MUTED} tickLine={false} fontSize={11} tickFormatter={(v: number) => fmtUsd(v, 0)} width={64} />
                    <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${fmtUsd(+v)} (${p.payload.n} trades)`, 'P&L']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <ReferenceLine y={0} stroke={INK_MUTED} />
                    <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                      {byInstrument.map(d => <Cell key={d.key} fill={d.pnl >= 0 ? UP : DOWN} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card lg:col-span-2">
              <h3 className="text-sm font-semibold text-ink mb-3">Instrument Breakdown</h3>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Symbol</th>
                    <th className="th">Trades</th>
                    <th className="th">Win%</th>
                    <th className="th text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {byInstrument.map(b => (
                    <tr key={b.key}>
                      <td className="td font-medium text-ink">{b.key}</td>
                      <td className="td">{b.n}</td>
                      <td className="td">{fmtPct(b.winRate)}</td>
                      <td className={`td text-right font-medium ${b.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                        {b.pnl >= 0 ? '+' : ''}{fmtUsd(b.pnl, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── By Session ── */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="card lg:col-span-3">
              <h3 className="text-sm font-semibold text-ink mb-3">P&amp;L by Session (GMT)</h3>
              <div className="h-44">
                <ResponsiveContainer>
                  <BarChart data={bySession} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                    <XAxis dataKey="key" stroke={INK_MUTED} tickLine={false} fontSize={11} />
                    <YAxis stroke={INK_MUTED} tickLine={false} fontSize={11} tickFormatter={(v: number) => fmtUsd(v, 0)} width={64} />
                    <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${fmtUsd(+v)} (${p.payload.n} trades)`, 'P&L']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <ReferenceLine y={0} stroke={INK_MUTED} />
                    <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                      {bySession.map(d => <Cell key={d.key} fill={d.pnl >= 0 ? UP : DOWN} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card lg:col-span-2">
              <h3 className="text-sm font-semibold text-ink mb-1">Session Breakdown</h3>
              <p className="text-[11px] text-muted mb-3">Asian: 00–08 · London: 08–16 · NY: 16–22 GMT</p>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Session</th>
                    <th className="th">Trades</th>
                    <th className="th">Win%</th>
                    <th className="th text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {bySession.filter(b => b.n > 0).map(b => (
                    <tr key={b.key}>
                      <td className="td text-ink">{b.key}</td>
                      <td className="td">{b.n}</td>
                      <td className="td">{fmtPct(b.winRate)}</td>
                      <td className={`td text-right font-medium ${b.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                        {b.pnl >= 0 ? '+' : ''}{fmtUsd(b.pnl, 0)}
                      </td>
                    </tr>
                  ))}
                  {bySession.every(b => b.n === 0) && (
                    <tr><td className="td text-muted col-span-4" colSpan={4}>No session data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Trade Quality ── */}
          {byGrade.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-ink mb-1">Trade Quality Distribution</h3>
              <p className="text-[11px] text-muted mb-3">
                Grade A = perfect execution · B = good · C = average · D = poor ·{' '}
                {trades.filter(t => t.grade).length} of {trades.length} trades graded
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {byGrade.map(b => (
                  <div
                    key={b.key}
                    className="rounded-xl border p-4 space-y-1"
                    style={{ borderColor: (GRADE_COLORS[b.key] ?? '#383835') + '50', background: (GRADE_COLORS[b.key] ?? '#383835') + '0a' }}
                  >
                    <div className="flex items-baseline gap-2">
                      <GradeBadge grade={b.key} />
                      <span className="text-xs text-muted">{b.n} trades</span>
                    </div>
                    <div className={`text-base font-semibold ${b.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                      {b.pnl >= 0 ? '+' : ''}{fmtUsd(b.pnl, 0)}
                    </div>
                    <div className="text-xs text-muted">{fmtPct(b.winRate)} win rate</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Psychology: Emotion Before ── */}
          {byEmotionBefore.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-ink mb-1">Psychology: Emotion Before Trade</h3>
              <p className="text-[11px] text-muted mb-3">
                How your pre-trade emotional state correlates with performance ·{' '}
                {trades.filter(t => t.emotionBefore).length} of {trades.length} trades tagged
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="h-44">
                  <ResponsiveContainer>
                    <BarChart data={byEmotionBefore} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                      <XAxis dataKey="key" stroke={INK_MUTED} tickLine={false} fontSize={10} />
                      <YAxis stroke={INK_MUTED} tickLine={false} fontSize={11} tickFormatter={(v: number) => fmtUsd(v, 0)} width={64} />
                      <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${fmtUsd(+v)} (${p.payload.n} trades)`, 'P&L']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <ReferenceLine y={0} stroke={INK_MUTED} />
                      <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                        {byEmotionBefore.map(d => <Cell key={d.key} fill={d.pnl >= 0 ? UP : DOWN} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table className="w-full self-start">
                  <thead>
                    <tr>
                      <th className="th">Emotion</th>
                      <th className="th">Trades</th>
                      <th className="th">Win%</th>
                      <th className="th text-right">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byEmotionBefore.map(b => (
                      <tr key={b.key}>
                        <td className="td text-ink">{b.key}</td>
                        <td className="td">{b.n}</td>
                        <td className="td">{fmtPct(b.winRate)}</td>
                        <td className={`td text-right font-medium ${b.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                          {b.pnl >= 0 ? '+' : ''}{fmtUsd(b.pnl, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── No psychology data hint ── */}
          {byGrade.length === 0 && byEmotionBefore.length === 0 && (
            <div className="card text-center py-8 space-y-1">
              <div className="text-sm text-ink2">No psychology data yet</div>
              <p className="text-xs text-muted">Grade your trades and tag emotions when adding or reviewing trades to unlock these insights.</p>
            </div>
          )}

        </div>
      )}
    </div>
  )
}
