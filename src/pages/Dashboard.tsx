import { useMemo } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { fmtDuration, fmtPct, fmtUsd } from '../lib/gold'
import { bucketStats, dayOfWeek, DOW, equityCurve, hourOfDay, summarize } from '../lib/stats'
import { Empty, PageHead, StatCard } from '../components/ui'
import { useAccountFilter } from '../components/useAccountFilter'

const INK_MUTED = '#898781'
const GRID = '#2c2c2a'
const BLUE = '#3987e5'
const UP = '#0ca30c'
const DOWN = '#d03b3b'

const tooltipStyle = {
  contentStyle: { background: '#222221', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#c3c2b7' },
  itemStyle: { color: '#ffffff' },
}

export default function Dashboard() {
  const { element: accountSelect, trades } = useAccountFilter()
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])
  const s = useMemo(() => summarize(trades), [trades])
  const curve = useMemo(() => equityCurve(trades), [trades])
  const byDow = useMemo(() => {
    const m = new Map(bucketStats(trades, t => dayOfWeek(t.entryTime)).map(b => [b.key, b]))
    return DOW.filter(d => d !== 'Sat').map(d => m.get(d) ?? { key: d, n: 0, pnl: 0, winRate: 0 })
  }, [trades])
  const byHour = useMemo(() => {
    const m = new Map(bucketStats(trades, t => hourOfDay(t.entryTime)).map(b => [b.key, b]))
    return Array.from({ length: 24 }, (_, h) => {
      const k = String(h).padStart(2, '0')
      return m.get(k) ?? { key: k, n: 0, pnl: 0, winRate: 0 }
    })
  }, [trades])
  const bySetup = useMemo(() => {
    const name = (id: string) => (id === '—' ? 'No setup' : setups?.find(x => String(x.id) === id)?.name ?? `#${id}`)
    return bucketStats(trades, t => String(t.setupId ?? '—')).map(b => ({ ...b, key: name(b.key) })).sort((a, b) => b.pnl - a.pnl)
  }, [trades, setups])

  return (
    <div className="pb-8">
      <PageHead title="Dashboard" sub="All stats computed from your journaled trades · times in GMT" right={accountSelect} />
      {!trades.length ? (
        <div className="px-6"><Empty text="No trades yet — run a backtest session and your stats will appear here." /></div>
      ) : (
        <div className="px-6 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
            <StatCard label="Net P&L" value={fmtUsd(s.netPnl, 0)} tone={s.netPnl > 0 ? 'up' : s.netPnl < 0 ? 'down' : 'none'} hint={`${s.n} trades`} />
            <StatCard label="Win rate" value={fmtPct(s.winRate)} hint={`${s.wins}W · ${s.losses}L${s.breakeven ? ` · ${s.breakeven}BE` : ''}`} />
            <StatCard label="Profit factor" value={isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} hint={`${fmtUsd(s.grossWin, 0)} gross win / ${fmtUsd(s.grossLoss, 0)} gross loss`} />
            <StatCard label="Expectancy" value={fmtUsd(s.expectancy)} tone={s.expectancy > 0 ? 'up' : 'down'} hint="avg P&L per trade" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
            <StatCard label="Avg win / loss" value={s.avgLoss > 0 ? (s.avgWin / s.avgLoss).toFixed(2) : '—'} hint={`${fmtUsd(s.avgWin, 0)} avg win / ${fmtUsd(s.avgLoss, 0)} avg loss`} />
            <StatCard label="Total R" value={`${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}R`} tone={s.totalR > 0 ? 'up' : 'down'} hint={`avg ${s.avgR.toFixed(2)}R per trade`} />
            <StatCard label="Max drawdown" value={fmtUsd(s.maxDrawdown, 0)} tone="down" hint="peak-to-trough on equity curve" />
            <StatCard label="Sharpe ratio" value={isFinite(s.sharpe) ? s.sharpe.toFixed(2) : '—'} tone={s.sharpe > 1 ? 'up' : s.sharpe < 0 ? 'down' : 'none'} hint={`streak ${s.currentStreak > 0 ? `+${s.currentStreak}W` : s.currentStreak < 0 ? `${s.currentStreak}L` : '—'} · avg hold ${fmtDuration(s.avgDurationSec)}`} />
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold text-ink mb-3">Equity curve (cumulative P&L)</h3>
            <div className="h-64">
              <ResponsiveContainer>
                <AreaChart data={curve} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={BLUE} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="i" stroke={INK_MUTED} tickLine={false} fontSize={11} label={undefined} />
                  <YAxis stroke={INK_MUTED} tickLine={false} fontSize={11} tickFormatter={(v: number) => fmtUsd(v, 0)} width={72} />
                  <Tooltip {...tooltipStyle} formatter={(v: any) => [fmtUsd(+v), 'Equity']} labelFormatter={(l: any) => `Trade #${l}`} />
                  <ReferenceLine y={0} stroke={INK_MUTED} strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="equity" stroke={BLUE} strokeWidth={2} fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PnlBarCard title="P&L by day of week (entry, GMT)" data={byDow} />
            <PnlBarCard title="P&L by hour of day (entry, GMT)" data={byHour} slim />
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold text-ink mb-2">Performance by setup</h3>
            <table className="w-full">
              <thead><tr><th className="th">Setup</th><th className="th">Trades</th><th className="th">Win rate</th><th className="th text-right">Net P&L</th></tr></thead>
              <tbody>
                {bySetup.map(b => (
                  <tr key={b.key}>
                    <td className="td text-ink">{b.key}</td>
                    <td className="td">{b.n}</td>
                    <td className="td">{fmtPct(b.winRate)}</td>
                    <td className={`td text-right font-medium ${b.pnl > 0 ? 'text-up' : b.pnl < 0 ? 'text-down' : ''}`}>{b.pnl > 0 ? '+' : ''}{fmtUsd(b.pnl, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function PnlBarCard({ title, data, slim }: { title: string; data: { key: string; pnl: number; n: number }[]; slim?: boolean }) {
  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-ink mb-3">{title}</h3>
      <div className="h-52">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }} barCategoryGap={slim ? '20%' : '30%'}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="key" stroke={INK_MUTED} tickLine={false} fontSize={10} interval={slim ? 2 : 0} />
            <YAxis stroke={INK_MUTED} tickLine={false} fontSize={11} tickFormatter={(v: number) => fmtUsd(v, 0)} width={64} />
            <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${fmtUsd(+v)} (${p.payload.n} trades)`, 'P&L']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <ReferenceLine y={0} stroke={INK_MUTED} />
            <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
              {data.map(d => <Cell key={d.key} fill={d.pnl >= 0 ? UP : DOWN} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
