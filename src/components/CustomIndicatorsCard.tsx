// Settings card: define your own overlay indicators in JavaScript. The runtime
// contract lives in src/replay/customEval.ts — user code executes as
//   function(bars, helpers) { <user body> }
// and must return an array of numbers matching bars.length.

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type CustomIndicatorDef } from '../db'
import { EXAMPLES, runCustomIndicator } from '../replay/customEval'
import { INDICATOR_COLORS } from '../replay/indicators'
import type { Bar } from '../lib/types'
import { Modal } from './ui'

export default function CustomIndicatorsCard() {
  const defs = useLiveQuery(() => db.customIndicators.orderBy('updatedAt').reverse().toArray(), [], [] as CustomIndicatorDef[])
  const [editing, setEditing] = useState<CustomIndicatorDef | 'new' | null>(null)

  const del = async (d: CustomIndicatorDef) => {
    if (!confirm(`Delete custom indicator "${d.name}"? Any charts that reference it will silently drop the line.`)) return
    if (d.id !== undefined) await db.customIndicators.delete(d.id)
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Custom indicators</h3>
        <button className="btn-primary text-xs" onClick={() => setEditing('new')}>+ New indicator</button>
      </div>
      <p className="text-xs text-muted">
        Write your own overlay indicators in JavaScript. Available in every chart's ƒ menu after saving.
        User code gets <span className="text-ink2">bars</span> and a <span className="text-ink2">helpers</span> bag
        (<span className="text-ink2">sma, ema, rma, stdev, highest, lowest, change</span>) and returns an array
        of numbers matching <span className="text-ink2">bars.length</span> — NaN for warmup / gap bars.
      </p>

      {!defs.length ? (
        <div className="text-xs text-muted">No custom indicators yet. Click <span className="text-ink2">+ New indicator</span> — the modal has starter examples.</div>
      ) : (
        <div className="space-y-1">
          {defs.map(d => (
            <div key={d.id} className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-2.5 py-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
              <span className="text-xs text-ink font-medium">{d.name}</span>
              <span className="text-[11px] text-muted">{d.overlay ? 'overlay' : 'oscillator'}</span>
              <button className="btn-ghost !px-2 !py-0.5 text-[11px] ml-auto" onClick={() => setEditing(d)}>Edit</button>
              <button className="text-muted hover:text-down text-sm" title="Delete" onClick={() => void del(d)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CustomIndicatorModal
          def={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// Synthetic bars for the Test button — 200 candles of a gentle sine + drift, so
// most sensible indicator code produces non-NaN output on them.
function testBars(): Bar[] {
  const now = Math.floor(Date.now() / 1000)
  const out: Bar[] = []
  let px = 100
  for (let i = 0; i < 200; i++) {
    const drift = Math.sin(i / 8) * 1.2 + (i - 100) * 0.02
    const o = px
    const c = 100 + drift + Math.sin(i / 3) * 0.4
    const h = Math.max(o, c) + 0.3
    const l = Math.min(o, c) - 0.3
    out.push({ time: now - (200 - i) * 60, open: o, high: h, low: l, close: c, volume: 100 + (i % 7) * 10 })
    px = c
  }
  return out
}

function CustomIndicatorModal({ def, onClose }: { def: CustomIndicatorDef | null; onClose: () => void }) {
  const [name, setName] = useState(def?.name ?? '')
  const [code, setCode] = useState(def?.code ?? EXAMPLES[0].code)
  const [color, setColor] = useState(def?.color ?? INDICATOR_COLORS[0])
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => { setTestResult(null) }, [code])

  const runTest = () => {
    const bars = testBars()
    const t0 = performance.now()
    const { values, error } = runCustomIndicator(code, bars)
    const dt = performance.now() - t0
    if (error) { setTestResult({ ok: false, msg: error }); return }
    if (values.length !== bars.length) {
      setTestResult({ ok: false, msg: `Returned ${values.length} values but bars.length was ${bars.length}` })
      return
    }
    const finiteCount = values.filter(v => isFinite(v)).length
    if (!finiteCount) {
      setTestResult({ ok: false, msg: 'Returned all NaN — check helper arguments and warmup handling.' })
      return
    }
    const last = values[values.length - 1]
    setTestResult({
      ok: true,
      msg: `OK — ${finiteCount}/${bars.length} finite values, last = ${isFinite(last) ? last.toFixed(4) : 'NaN'} (${dt.toFixed(1)} ms)`,
    })
  }

  const save = async () => {
    const rec = { name: name.trim(), code, color, overlay: true, updatedAt: Date.now() }
    if (!rec.name) return
    if (def?.id !== undefined) {
      await db.customIndicators.update(def.id, rec)
    } else {
      await db.customIndicators.add({ ...rec, createdAt: Date.now() })
    }
    onClose()
  }

  const loadExample = (idx: number) => { setCode(EXAMPLES[idx].code); if (!name) setName(EXAMPLES[idx].name) }

  return (
    <Modal title={def ? 'Edit custom indicator' : 'New custom indicator'} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="e.g. HMA 21" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Line color</label>
            <div className="flex gap-1">
              {INDICATOR_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`w-6 h-6 rounded-full border ${color === c ? 'border-white' : 'border-transparent'}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted">Start from example:</span>
          {EXAMPLES.map((e, i) => (
            <button key={i} type="button" className="btn-ghost text-[11px] !px-2 !py-0.5" onClick={() => loadExample(i)}>
              {e.name}
            </button>
          ))}
        </div>

        <div>
          <label className="label">Code (JavaScript)</label>
          <textarea
            className="input font-mono text-xs w-full min-h-[260px] leading-snug"
            spellCheck={false}
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => {
              // Tab inserts a tab instead of jumping focus — small quality-of-life for the editor.
              if (e.key === 'Tab') {
                e.preventDefault()
                const el = e.currentTarget
                const s = el.selectionStart, en = el.selectionEnd
                const next = code.slice(0, s) + '  ' + code.slice(en)
                setCode(next)
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2 })
              }
            }}
          />
        </div>

        <ContractHelp />

        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={runTest}>Test</button>
          {testResult && (
            <span className={`text-[11px] ${testResult.ok ? 'text-up' : 'text-down'} whitespace-pre-wrap`}>
              {testResult.msg}
            </span>
          )}
        </div>

        <div className="flex justify-between pt-2 border-t border-hairline">
          {def
            ? <button type="button" className="btn-ghost !text-down" onClick={async () => {
                if (def.id === undefined) return
                if (!confirm(`Delete "${def.name}"?`)) return
                await db.customIndicators.delete(def.id); onClose()
              }}>Delete</button>
            : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={save} disabled={!name.trim()}>Save</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function ContractHelp() {
  return (
    <details className="text-[11px] text-muted rounded-md border border-hairline bg-black/20 p-2">
      <summary className="cursor-pointer text-ink2">Contract & helpers</summary>
      <div className="mt-2 space-y-2">
        <p><span className="text-ink2">bars</span>: <code>{'{ time, open, high, low, close, volume }[]'}</code> — length varies per chart.</p>
        <p><span className="text-ink2">helpers</span>:</p>
        <ul className="pl-4 space-y-0.5">
          <li><code>helpers.sma(values, L)</code> — simple moving average, NaN for i &lt; L-1.</li>
          <li><code>helpers.ema(values, L)</code> — exponential MA (seeded with SMA of first L).</li>
          <li><code>helpers.rma(values, L)</code> — Wilder / RMA (used by ATR, RSI).</li>
          <li><code>helpers.stdev(values, L)</code> — population standard deviation over L.</li>
          <li><code>helpers.highest(values, L)</code> / <code>helpers.lowest(values, L)</code>.</li>
          <li><code>helpers.change(values)</code> — first differences, NaN at i=0.</li>
        </ul>
        <p>Return an array of numbers matching <code>bars.length</code>. Use <code>NaN</code> for warmup bars — they render as gaps. No async, no I/O.</p>
      </div>
    </details>
  )
}
