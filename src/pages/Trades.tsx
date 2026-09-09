import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { Direction, ExitReason, Trade, TradeGrade } from '../lib/types'
import { fmtDateTime, fmtDuration, fmtR, fmtUsd, pnlUsd, riskUsd } from '../lib/gold'
import { fmtPx } from '../lib/symbols'
import { useSymbolList } from '../lib/instruments'
import { EmotionPicker, Empty, GradeBadge, GradePicker, Modal, PageHead, PnlText, emotionLabel } from '../components/ui'
import { useAccountFilter } from '../components/useAccountFilter'
import AnalyzeButton from '../components/AnalyzeButton'

export default function Trades() {
  const { element: accountSelect, trades, accounts } = useAccountFilter()
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])
  const [dir, setDir] = useState<'all' | Direction>('all')
  const [result, setResult] = useState<'all' | 'win' | 'loss'>('all')
  const [gradeFilter, setGradeFilter] = useState('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)

  const filtered = useMemo(() => {
    let t = [...trades].sort((a, b) => b.exitTime - a.exitTime)
    if (dir !== 'all') t = t.filter(x => x.direction === dir)
    if (result === 'win') t = t.filter(x => x.pnl > 0)
    if (result === 'loss') t = t.filter(x => x.pnl < 0)
    if (gradeFilter === 'none') t = t.filter(x => !x.grade)
    else if (gradeFilter) t = t.filter(x => x.grade === gradeFilter)
    if (q.trim()) {
      const needle = q.toLowerCase()
      t = t.filter(x =>
        (x.notes + ' ' + (x.postNotes ?? '') + ' ' + x.tags.join(' ') + ' ' + x.mistakes.join(' ') + ' ' + x.symbol)
          .toLowerCase()
          .includes(needle),
      )
    }
    return t
  }, [trades, dir, result, gradeFilter, q])

  const setupName = (id?: number) => setups?.find(s => s.id === id)?.name ?? '—'
  const open = filtered.find(t => t.id === openId) ?? trades.find(t => t.id === openId)

  return (
    <div className="pb-8">
      <PageHead
        title="Trades"
        sub={`${filtered.length} of ${trades.length} trades`}
        right={
          <div className="flex gap-2">
            <AnalyzeButton trades={filtered} scope={`${filtered.length} filtered trades`} className="btn-ghost text-xs" />
            <button className="btn-ghost" onClick={() => setImporting(true)}>Import CSV</button>
            <button className="btn-primary" onClick={() => setAdding(true)}>+ Add Trade</button>
          </div>
        }
      />
      <div className="px-6 flex flex-wrap items-center gap-2 mb-3">
        {accountSelect}
        <select className="input !w-auto" value={dir} onChange={e => setDir(e.target.value as any)}>
          <option value="all">All directions</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select className="input !w-auto" value={result} onChange={e => setResult(e.target.value as any)}>
          <option value="all">All results</option>
          <option value="win">Wins</option>
          <option value="loss">Losses</option>
        </select>
        <select className="input !w-auto" value={gradeFilter} onChange={e => setGradeFilter(e.target.value)}>
          <option value="">All grades</option>
          <option value="A">Grade A — Perfect</option>
          <option value="B">Grade B — Good</option>
          <option value="C">Grade C — Average</option>
          <option value="D">Grade D — Poor</option>
          <option value="none">Ungraded</option>
        </select>
        <input
          className="input !w-56"
          placeholder="Search notes / tags / mistakes…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      <div className="px-6">
        {!filtered.length ? (
          <Empty text="No trades match." />
        ) : (
          <div className="card !p-0 overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Closed (GMT)</th>
                  <th className="th">Dir</th>
                  <th className="th">Lots</th>
                  <th className="th">Entry → Exit</th>
                  <th className="th">Hold</th>
                  <th className="th">Setup</th>
                  <th className="th">Grade</th>
                  <th className="th">Exit</th>
                  <th className="th text-right">R</th>
                  <th className="th text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} className="hover:bg-white/5 cursor-pointer" onClick={() => setOpenId(t.id!)}>
                    <td className="td text-muted">{fmtDateTime(t.exitTime)}</td>
                    <td className={`td font-medium ${t.direction === 'long' ? 'text-up' : 'text-down'}`}>
                      {t.direction === 'long' ? '▲ L' : '▼ S'}
                    </td>
                    <td className="td">{t.lots}</td>
                    <td className="td">
                      {t.symbol !== 'XAUUSD' && <span className="text-muted">{t.symbol} </span>}
                      {fmtPx(t.entryPrice, t.symbol)} → {fmtPx(t.exitPrice, t.symbol)}
                    </td>
                    <td className="td text-muted">{fmtDuration(t.exitTime - t.entryTime)}</td>
                    <td className="td text-muted">{setupName(t.setupId)}</td>
                    <td className="td">{t.grade ? <GradeBadge grade={t.grade} /> : <span className="text-muted">—</span>}</td>
                    <td className="td text-muted uppercase text-[10px]">{t.exitReason}</td>
                    <td className="td text-right text-muted">{fmtR(t.rMultiple)}</td>
                    <td className="td text-right font-medium"><PnlText v={t.pnl} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && (
        <TradeDetail
          trade={open}
          setupName={setupName(open.setupId)}
          onClose={() => setOpenId(null)}
        />
      )}
      {adding && <AddTrade accounts={accounts} onClose={() => setAdding(false)} />}
      {importing && <ImportCsv accounts={accounts} onClose={() => setImporting(false)} />}
    </div>
  )
}

/* ── Trade detail modal ── */

function TradeDetail({ trade, setupName, onClose }: { trade: Trade; setupName: string; onClose: () => void }) {
  const [notes, setNotes] = useState(trade.notes)
  const [postNotes, setPostNotes] = useState(trade.postNotes ?? '')
  const [mistakes, setMistakes] = useState(trade.mistakes.join(', '))
  const [tags, setTags] = useState(trade.tags.join(', '))
  const [grade, setGrade] = useState<string>(trade.grade ?? '')
  const [emotionBefore, setEmotionBefore] = useState<number | undefined>(trade.emotionBefore)
  const [emotionAfter, setEmotionAfter] = useState<number | undefined>(trade.emotionAfter)
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!trade.screenshot) return
    const url = URL.createObjectURL(trade.screenshot)
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [trade.screenshot])

  const save = async () => {
    await db.trades.update(trade.id!, {
      notes,
      postNotes: postNotes.trim() || undefined,
      mistakes: mistakes.split(',').map(s => s.trim()).filter(Boolean),
      tags: tags.split(',').map(s => s.trim()).filter(Boolean),
      grade: (grade as TradeGrade) || undefined,
      emotionBefore: emotionBefore || undefined,
      emotionAfter: emotionAfter || undefined,
    })
    onClose()
  }

  const del = async () => {
    if (!confirm('Delete this trade permanently?')) return
    await db.trades.delete(trade.id!)
    onClose()
  }

  return (
    <Modal title={`${trade.symbol} · ${trade.direction.toUpperCase()} ${trade.lots} lots`} onClose={onClose} wide>
      <div className="space-y-4">
        {imgUrl && <img src={imgUrl} alt="chart at exit" className="w-full rounded-lg border border-white/10" />}

        {/* Core stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Info label="Entry" value={`${fmtPx(trade.entryPrice, trade.symbol)} · ${fmtDateTime(trade.entryTime)}`} />
          <Info label="Exit" value={`${fmtPx(trade.exitPrice, trade.symbol)} · ${fmtDateTime(trade.exitTime)}`} />
          <Info label="SL / TP" value={`${trade.sl !== undefined ? fmtPx(trade.sl, trade.symbol) : '—'} / ${trade.tp !== undefined ? fmtPx(trade.tp, trade.symbol) : '—'}`} />
          <Info label="Exit reason" value={trade.exitReason.toUpperCase()} />
          <Info label="P&L (net)" value={`${trade.pnl >= 0 ? '+' : ''}${fmtUsd(trade.pnl)}`} tone={trade.pnl >= 0 ? 'up' : 'down'} />
          <Info label="R multiple" value={fmtR(trade.rMultiple)} />
          <Info label="Risk" value={trade.riskAmount !== undefined ? fmtUsd(trade.riskAmount, 0) : '—'} />
          <Info label="Setup" value={setupName} />
        </div>

        {/* Psychology row */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="label">Trade Grade</div>
            <GradePicker value={grade} onChange={setGrade} />
          </div>
          <div>
            <div className="label">Emotion Before</div>
            <EmotionPicker value={emotionBefore} onChange={setEmotionBefore} type="before" />
          </div>
          <div>
            <div className="label">Emotion After</div>
            <EmotionPicker value={emotionAfter} onChange={setEmotionAfter} type="after" />
          </div>
        </div>

        {/* Confirmations */}
        {trade.confirmations.length > 0 && (
          <div>
            <div className="label">Confirmations at entry ({trade.confirmations.filter(c => c.checked).length}/{trade.confirmations.length})</div>
            <div className="space-y-1">
              {trade.confirmations.map(c => (
                <div key={c.label} className="text-xs">
                  {c.checked ? '✅' : '⬜'}{' '}
                  <span className={c.checked ? 'text-ink2' : 'text-muted'}>{c.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">Pre-trade Notes</label>
            <textarea className="input min-h-[80px]" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Why did you take this trade?" />
          </div>
          <div>
            <label className="label">Post-trade Review</label>
            <textarea className="input min-h-[80px]" value={postNotes} onChange={e => setPostNotes(e.target.value)} placeholder="What happened? Lessons learned?" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Mistakes (comma-separated)</label>
            <input className="input" placeholder="moved stop, FOMO entry…" value={mistakes} onChange={e => setMistakes(e.target.value)} />
          </div>
          <div>
            <label className="label">Tags (comma-separated)</label>
            <input className="input" placeholder="news day, asia session…" value={tags} onChange={e => setTags(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-between">
          <button className="btn-ghost !text-down" onClick={del}>Delete trade</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  )
}

function Info({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-sm ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'}`}>{value}</div>
    </div>
  )
}

/* ── Section divider helper ── */

function Section({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="text-[10px] font-semibold text-muted uppercase tracking-wider">{title}</div>
      <div className="flex-1 h-px bg-hairline" />
    </div>
  )
}

/* ── Manual add trade modal ── */

function AddTrade({ accounts, onClose }: { accounts: { id?: number; name: string }[]; onClose: () => void }) {
  const SYMBOL_LIST = useSymbolList()
  const setups = useLiveQuery(() => db.setups.toArray(), [], [])

  const [f, setF] = useState({
    accountId: accounts[0]?.id ?? 0,
    symbol: 'XAUUSD',
    direction: 'long' as Direction,
    lots: 0.1,
    entryTime: '',
    exitTime: '',
    entryPrice: '',
    exitPrice: '',
    sl: '',
    tp: '',
    fees: '0',
    exitReason: 'manual' as ExitReason,
    setupId: '' as string | number,
    notes: '',
    postNotes: '',
    mistakes: '',
    tags: '',
  })
  const [grade, setGrade] = useState<string>('')
  const [emotionBefore, setEmotionBefore] = useState<number | undefined>(undefined)
  const [emotionAfter, setEmotionAfter] = useState<number | undefined>(undefined)
  const [error, setError] = useState('')

  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }))

  const save = async () => {
    try {
      const entryTime = Date.parse(f.entryTime + ':00Z') / 1000
      const exitTime = Date.parse(f.exitTime + ':00Z') / 1000
      if (!isFinite(entryTime) || !isFinite(exitTime)) throw new Error('Entry and exit times are required')
      const entryPrice = +f.entryPrice, exitPrice = +f.exitPrice, fees = +f.fees || 0
      if (!isFinite(entryPrice) || !isFinite(exitPrice)) throw new Error('Prices are required')
      const pnl = +(pnlUsd(f.direction, entryPrice, exitPrice, f.lots, f.symbol) - fees).toFixed(2)
      const sl = f.sl === '' ? undefined : +f.sl
      const tp = f.tp === '' ? undefined : +f.tp
      const risk = sl !== undefined ? riskUsd(f.direction, entryPrice, sl, f.lots, f.symbol) : undefined
      await db.trades.add({
        accountId: +f.accountId,
        symbol: f.symbol,
        direction: f.direction,
        lots: f.lots,
        entryTime, exitTime, entryPrice, exitPrice,
        sl, tp, pnl, fees,
        exitReason: f.exitReason,
        setupId: f.setupId !== '' ? +f.setupId : undefined,
        riskAmount: risk,
        rMultiple: risk && risk > 0 ? +(pnl / risk).toFixed(3) : undefined,
        confirmations: [],
        mistakes: f.mistakes.split(',').map(s => s.trim()).filter(Boolean),
        notes: f.notes,
        postNotes: f.postNotes.trim() || undefined,
        tags: f.tags.split(',').map(s => s.trim()).filter(Boolean),
        grade: (grade as TradeGrade) || undefined,
        emotionBefore: emotionBefore || undefined,
        emotionAfter: emotionAfter || undefined,
      })
      onClose()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  return (
    <Modal title="Add Trade" onClose={onClose} wide>
      <div className="space-y-4">
        {/* ── Trade Details ── */}
        <Section title="Trade Details" />
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Account</label>
            <select className="input" value={f.accountId} onChange={e => set('accountId', +e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Symbol</label>
            <select className="input" value={f.symbol} onChange={e => set('symbol', e.target.value)}>
              {SYMBOL_LIST.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Direction</label>
            <div className="flex gap-1.5 mt-1">
              {(['long', 'short'] as Direction[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => set('direction', d)}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    f.direction === d
                      ? d === 'long'
                        ? 'bg-up/15 border-up/40 text-up'
                        : 'bg-down/15 border-down/40 text-down'
                      : 'border-hairline text-muted hover:border-white/25'
                  }`}
                >
                  {d === 'long' ? '▲ Long' : '▼ Short'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Entry Time (GMT)</label>
            <input type="datetime-local" className="input" value={f.entryTime} onChange={e => set('entryTime', e.target.value)} />
          </div>
          <div>
            <label className="label">Exit Time (GMT)</label>
            <input type="datetime-local" className="input" value={f.exitTime} onChange={e => set('exitTime', e.target.value)} />
          </div>
          <div>
            <label className="label">Lots / Contracts</label>
            <input type="number" step="0.01" className="input" value={f.lots} onChange={e => set('lots', +e.target.value)} />
          </div>
          <div>
            <label className="label">Entry Price</label>
            <input type="number" step="0.01" className="input" value={f.entryPrice} onChange={e => set('entryPrice', e.target.value)} />
          </div>
          <div>
            <label className="label">Exit Price</label>
            <input type="number" step="0.01" className="input" value={f.exitPrice} onChange={e => set('exitPrice', e.target.value)} />
          </div>
          <div>
            <label className="label">Fees ($)</label>
            <input type="number" step="0.5" className="input" value={f.fees} onChange={e => set('fees', e.target.value)} />
          </div>
        </div>

        {/* ── Risk & Setup ── */}
        <Section title="Risk &amp; Setup" />
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Stop Loss (optional)</label>
            <input type="number" step="0.01" className="input" value={f.sl} onChange={e => set('sl', e.target.value)} />
          </div>
          <div>
            <label className="label">Take Profit (optional)</label>
            <input type="number" step="0.01" className="input" value={f.tp} onChange={e => set('tp', e.target.value)} />
          </div>
          <div>
            <label className="label">Exit Reason</label>
            <select className="input" value={f.exitReason} onChange={e => set('exitReason', e.target.value)}>
              <option value="tp">Take Profit (TP)</option>
              <option value="sl">Stop Loss (SL)</option>
              <option value="manual">Manual Close</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="col-span-3">
            <label className="label">Setup</label>
            <select className="input" value={f.setupId} onChange={e => set('setupId', e.target.value)}>
              <option value="">— No setup —</option>
              {setups?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        {/* ── Psychology ── */}
        <Section title="Psychology &amp; Quality" />
        <div className="space-y-3">
          <div>
            <label className="label">Trade Grade</label>
            <GradePicker value={grade} onChange={setGrade} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Emotion Before Trade</label>
              <EmotionPicker value={emotionBefore} onChange={setEmotionBefore} type="before" />
            </div>
            <div>
              <label className="label">Emotion After Trade</label>
              <EmotionPicker value={emotionAfter} onChange={setEmotionAfter} type="after" />
            </div>
          </div>
        </div>

        {/* ── Notes & Tags ── */}
        <Section title="Notes &amp; Tags" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">Pre-trade Notes</label>
            <textarea className="input min-h-[72px]" placeholder="Why did you take this trade?" value={f.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          <div>
            <label className="label">Post-trade Review</label>
            <textarea className="input min-h-[72px]" placeholder="What happened? Lessons learned?" value={f.postNotes} onChange={e => set('postNotes', e.target.value)} />
          </div>
          <div>
            <label className="label">Mistakes (comma-separated)</label>
            <input className="input" placeholder="moved stop, FOMO entry…" value={f.mistakes} onChange={e => set('mistakes', e.target.value)} />
          </div>
          <div>
            <label className="label">Tags (comma-separated)</label>
            <input className="input" placeholder="news day, asia session…" value={f.tags} onChange={e => set('tags', e.target.value)} />
          </div>
        </div>

        <p className="text-[11px] text-muted">P&amp;L uses the symbol's contract math (gold: $100/pt/lot · FX: $10/pip/lot) minus fees.</p>
        {error && <div className="text-xs text-down">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={!accounts.length}>Save Trade</button>
        </div>
        {!accounts.length && <p className="text-xs text-warn">Create an account first (Settings page).</p>}
      </div>
    </Modal>
  )
}

/* ── CSV import ── */

const CSV_FIELDS = ['skip', 'direction', 'lots', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'pnl', 'symbol'] as const

function ImportCsv({ accounts, onClose }: { accounts: { id?: number; name: string }[]; onClose: () => void }) {
  const [rows, setRows] = useState<string[][]>([])
  const [header, setHeader] = useState<string[]>([])
  const [mapping, setMapping] = useState<string[]>([])
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? 0)
  const [msg, setMsg] = useState('')

  const onFile = async (file: File) => {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) { setMsg('File has no data rows.'); return }
    const head = lines[0].split(',').map(s => s.trim())
    setHeader(head)
    setRows(lines.slice(1).map(l => l.split(',').map(s => s.trim())))
    const guess = (h: string): string => {
      const s = h.toLowerCase()
      if (/(side|direction|type)/.test(s)) return 'direction'
      if (/(lot|qty|size|volume)/.test(s)) return 'lots'
      if (/open.*(time|date)|entry.*(time|date)|^(time|date)/.test(s)) return 'entryTime'
      if (/close.*(time|date)|exit.*(time|date)/.test(s)) return 'exitTime'
      if (/open.*price|entry|price.*open/.test(s)) return 'entryPrice'
      if (/close.*price|exit|price.*close/.test(s)) return 'exitPrice'
      if (/(pnl|profit|p&l)/.test(s)) return 'pnl'
      if (/symbol|instrument|pair/.test(s)) return 'symbol'
      return 'skip'
    }
    setMapping(head.map(guess))
    setMsg('')
  }

  const importRows = async () => {
    const col = (name: string) => mapping.indexOf(name)
    const iDir = col('direction'), iLots = col('lots'), iET = col('entryTime'), iXT = col('exitTime')
    const iEP = col('entryPrice'), iXP = col('exitPrice'), iPnl = col('pnl'), iSym = col('symbol')
    if (iET < 0 || iEP < 0 || iXP < 0) { setMsg('Map at least: entryTime, entryPrice, exitPrice.'); return }
    let ok = 0, bad = 0
    const parseTs = (s: string) => {
      let t = Date.parse(s)
      if (!isFinite(t)) t = Date.parse(s.replace(' ', 'T') + 'Z')
      return isFinite(t) ? t / 1000 : NaN
    }
    for (const r of rows) {
      try {
        const direction: Direction = iDir >= 0 && /s(ell|hort)/i.test(r[iDir]) ? 'short' : 'long'
        const lots = iLots >= 0 ? Math.abs(+r[iLots]) || 0.01 : 0.01
        const entryTime = parseTs(r[iET])
        const exitTime = iXT >= 0 ? parseTs(r[iXT]) : entryTime
        const entryPrice = +r[iEP], exitPrice = +r[iXP]
        if (!isFinite(entryTime) || !isFinite(entryPrice) || !isFinite(exitPrice)) throw new Error('bad row')
        const rowSymbol = iSym >= 0 ? r[iSym].toUpperCase() : 'XAUUSD'
        const pnl = iPnl >= 0 && isFinite(+r[iPnl]) ? +r[iPnl] : +pnlUsd(direction, entryPrice, exitPrice, lots, rowSymbol).toFixed(2)
        await db.trades.add({
          accountId: +accountId, symbol: rowSymbol, direction, lots,
          entryTime, exitTime: isFinite(exitTime) ? exitTime : entryTime, entryPrice, exitPrice,
          pnl, fees: 0, exitReason: 'other', confirmations: [], mistakes: [], notes: 'CSV import', tags: ['csv-import'],
        })
        ok++
      } catch { bad++ }
    }
    setMsg(`Imported ${ok} trades${bad ? `, skipped ${bad} bad rows` : ''}.`)
    setRows([])
  }

  return (
    <Modal title="Import trades from CSV" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="label">CSV file (first row = headers)</label>
            <input type="file" accept=".csv,.txt" className="input" onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
          </div>
          <div>
            <label className="label">Into account</label>
            <select className="input" value={accountId} onChange={e => setAccountId(+e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        {header.length > 0 && (
          <>
            <div className="text-xs text-muted">Map each column ({rows.length} data rows found):</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {header.map((h, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="text-ink2 truncate w-28" title={h}>{h}</span>
                  <select className="input !py-1 text-xs" value={mapping[i]} onChange={e => setMapping(m => m.map((v, j) => (j === i ? e.target.value : v)))}>
                    {CSV_FIELDS.map(fld => <option key={fld} value={fld}>{fld}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={importRows} disabled={!accounts.length}>Import {rows.length} rows</button>
          </>
        )}
        {msg && <div className="text-xs text-warn">{msg}</div>}
        {!accounts.length && <p className="text-xs text-warn">Create an account first (Settings page).</p>}
      </div>
    </Modal>
  )
}
