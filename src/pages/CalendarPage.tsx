import { useMemo, useState } from 'react'
import { fmtUsd } from '../lib/gold'
import { PageHead, PnlText } from '../components/ui'
import { useAccountFilter } from '../components/useAccountFilter'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function CalendarPage() {
  const { element: accountSelect, trades } = useAccountFilter()
  const now = new Date()
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getUTCFullYear(), m: now.getUTCMonth() })

  const daily = useMemo(() => {
    const map = new Map<string, { pnl: number; n: number }>()
    for (const t of trades) {
      const d = new Date(t.exitTime * 1000)
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
      const cur = map.get(key) ?? { pnl: 0, n: 0 }
      cur.pnl += t.pnl
      cur.n++
      map.set(key, cur)
    }
    return map
  }, [trades])

  const weeks = useMemo(() => {
    const first = new Date(Date.UTC(ym.y, ym.m, 1))
    const startOffset = first.getUTCDay() // 0 = Sun
    const daysInMonth = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate()
    const cells: ({ day: number; pnl: number; n: number } | null)[] = []
    for (let i = 0; i < startOffset; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const rec = daily.get(`${ym.y}-${ym.m}-${d}`)
      cells.push({ day: d, pnl: rec?.pnl ?? 0, n: rec?.n ?? 0 })
    }
    while (cells.length % 7) cells.push(null)
    const rows = []
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
    return rows
  }, [ym, daily])

  const monthPnl = weeks.flat().reduce((s, c) => s + (c?.pnl ?? 0), 0)
  const monthTrades = weeks.flat().reduce((s, c) => s + (c?.n ?? 0), 0)
  const nav = (d: number) => setYm(({ y, m }) => {
    const nm = m + d
    return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }
  })

  return (
    <div className="pb-8">
      <PageHead title="P&L Calendar" sub="Daily results by trade close date (GMT)" right={accountSelect} />
      <div className="px-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <button className="btn-ghost" onClick={() => nav(-1)}>←</button>
            <div className="text-center">
              <div className="text-ink font-semibold">{MONTHS[ym.m]} {ym.y}</div>
              <div className="text-xs mt-0.5">
                <PnlText v={+monthPnl.toFixed(2)} digits={0} /> <span className="text-muted">· {monthTrades} trades</span>
              </div>
            </div>
            <button className="btn-ghost" onClick={() => nav(1)}>→</button>
          </div>
          <div className="grid grid-cols-8 gap-1.5 text-center text-[11px] text-muted mb-1.5">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d}>{d}</div>)}
            <div>Week</div>
          </div>
          {weeks.map((row, wi) => {
            const wk = row.reduce((s, c) => s + (c?.pnl ?? 0), 0)
            const wn = row.reduce((s, c) => s + (c?.n ?? 0), 0)
            return (
              <div key={wi} className="grid grid-cols-8 gap-1.5 mb-1.5">
                {row.map((c, i) =>
                  c === null ? (
                    <div key={i} className="rounded-lg bg-white/[0.02] min-h-[72px]" />
                  ) : (
                    <div
                      key={i}
                      className={`rounded-lg min-h-[72px] p-1.5 border ${
                        c.n === 0
                          ? 'bg-white/[0.03] border-transparent'
                          : c.pnl > 0
                            ? 'bg-up/15 border-up/40'
                            : c.pnl < 0
                              ? 'bg-down/15 border-down/40'
                              : 'bg-white/5 border-white/10'
                      }`}
                    >
                      <div className="text-[11px] text-muted">{c.day}</div>
                      {c.n > 0 && (
                        <>
                          <div className={`text-xs font-semibold mt-1 ${c.pnl > 0 ? 'text-up' : c.pnl < 0 ? 'text-down' : 'text-ink2'}`}>
                            {c.pnl > 0 ? '+' : ''}{fmtUsd(c.pnl, 0)}
                          </div>
                          <div className="text-[10px] text-muted">{c.n} trade{c.n > 1 ? 's' : ''}</div>
                        </>
                      )}
                    </div>
                  ),
                )}
                <div className="rounded-lg min-h-[72px] p-1.5 bg-white/[0.03] border border-white/5">
                  <div className="text-[10px] text-muted">wk {wi + 1}</div>
                  {wn > 0 && (
                    <div className={`text-xs font-semibold mt-1 ${wk > 0 ? 'text-up' : wk < 0 ? 'text-down' : 'text-ink2'}`}>
                      {wk > 0 ? '+' : ''}{fmtUsd(wk, 0)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
