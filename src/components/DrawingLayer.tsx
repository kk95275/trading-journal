// TradingView-style drawing overlay for the replay chart.
// Rendering: a pointer-events-none canvas above the chart. Interaction: capture-phase
// pointer listeners on the chart container — when a tool is active or a drawing is hit,
// the event is consumed (stopPropagation) so the chart doesn't pan underneath.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts'
import type { Bar } from '../lib/types'
import type { ReplayEngine } from '../replay/engine'
import {
  DRAW_COLORS, distToSegment, nearestIndex, nextDrawingId,
  type Anchor, type Drawing, type TextH, type TextV, type Tool,
} from '../replay/drawings'

interface Props {
  container: HTMLElement
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  engine: ReplayEngine
  getBars: () => Bar[]
  dataVersion: number
  onCanvas: (c: HTMLCanvasElement | null) => void
}

type DragState =
  | { mode: 'move'; id: number; startX: number; startY: number; origA: Anchor; origB?: Anchor }
  | { mode: 'a' | 'b'; id: number }

interface Editing {
  x: number
  y: number
  id?: number // existing drawing → edit its text
  anchor?: Anchor // new text note
  value: string
}

const HIT = 7

export default function DrawingLayer({ container, chart, series, engine, getBars, dataVersion, onCanvas }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [tool, setTool] = useState<Tool>('cursor')
  const [color, setColor] = useState(DRAW_COLORS[0])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const pendingRef = useRef<{ a: Anchor; hover: Anchor | null } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const selRef = useRef(selectedId)
  toolRef.current = tool
  colorRef.current = color
  selRef.current = selectedId

  /* ---------- coordinate mapping ---------- */

  const timeToX = useCallback((time: number): number | null => {
    const bars = getBars()
    if (!bars.length) return null
    const idx = nearestIndex(bars, time)
    const ts = chart.timeScale()
    const x = ts.logicalToCoordinate(idx as Logical)
    if (x !== null) return x
    const vr = ts.getVisibleLogicalRange()
    if (!vr || vr.to === vr.from) return null
    return ((idx - vr.from) / (vr.to - vr.from)) * ts.width()
  }, [chart, getBars])

  const priceToY = useCallback((price: number): number | null => series.priceToCoordinate(price), [series])

  const pointToAnchor = useCallback((x: number, y: number): Anchor | null => {
    const bars = getBars()
    if (!bars.length) return null
    const ts = chart.timeScale()
    const logical = ts.coordinateToLogical(x)
    const price = series.coordinateToPrice(y)
    if (logical === null || price === null) return null
    const idx = Math.max(0, Math.min(bars.length - 1, Math.round(logical as number)))
    return { time: bars[idx].time, price: +price }
  }, [chart, series, getBars])

  /* ---------- rendering ---------- */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth, h = container.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const ts = chart.timeScale()
    const paneW = ts.width(), paneH = h - ts.height()
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, paneW, paneH)
    ctx.clip()

    const drawOne = (d: Drawing, selected: boolean) => {
      const xa = timeToX(d.a.time), ya = priceToY(d.a.price)
      ctx.strokeStyle = d.color
      ctx.fillStyle = d.color
      ctx.lineWidth = 1.5
      ctx.font = '11px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      if (d.kind === 'hline') {
        if (ya === null) return
        ctx.beginPath()
        ctx.moveTo(0, ya)
        ctx.lineTo(paneW, ya)
        ctx.stroke()
        if (d.text) {
          const tx = d.textH === 'center' ? paneW / 2 : d.textH === 'right' ? paneW - 6 : 6
          const ty = d.textV === 'middle' ? ya - 6 : d.textV === 'bottom' ? ya + 4 : ya - 15
          ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
          drawText(ctx, d.text, tx, ty)
          ctx.textAlign = 'left'
        }
        if (selected) handle(ctx, paneW / 2, ya, d.color)
        return
      }
      if (xa === null || ya === null) return
      if (d.kind === 'text') {
        ctx.beginPath()
        ctx.arc(xa, ya, 2, 0, Math.PI * 2)
        ctx.fill()
        drawText(ctx, d.text || '…', xa + 5, ya - 6)
        if (selected) handle(ctx, xa, ya, d.color)
        return
      }
      const xb = d.b ? timeToX(d.b.time) : null
      const yb = d.b ? priceToY(d.b.price) : null
      if (xb === null || yb === null) return
      if (d.kind === 'trend') {
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(xa, ya)
        ctx.lineTo(xb, yb)
        ctx.stroke()
        if (d.text) {
          // position along the line (left = start point, right = end point)
          const [sx, sy] = xa <= xb ? [xa, ya] : [xb, yb]
          const [ex, ey] = xa <= xb ? [xb, yb] : [xa, ya]
          const tx = d.textH === 'center' ? (sx + ex) / 2 : d.textH === 'right' ? ex : sx
          const anchorY = d.textH === 'center' ? (sy + ey) / 2 : d.textH === 'right' ? ey : sy
          const lines = d.text.split('\n').length
          const ty = d.textV === 'middle' ? anchorY - 6 : d.textV === 'bottom' ? anchorY + 8 : anchorY - 6 - lines * 14
          ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
          drawText(ctx, d.text, tx, ty)
          ctx.textAlign = 'left'
        }
      } else {
        const x = Math.min(xa, xb), y = Math.min(ya, yb)
        const rw = Math.abs(xb - xa), rh = Math.abs(yb - ya)
        ctx.globalAlpha = 0.13
        ctx.fillRect(x, y, rw, rh)
        ctx.globalAlpha = 1
        ctx.strokeRect(x, y, rw, rh)
        if (d.text) {
          const lines = d.text.split('\n').length
          const tx = d.textH === 'center' ? x + rw / 2 : d.textH === 'right' ? x + rw - 5 : x + 5
          const ty = d.textV === 'middle' ? y + rh / 2 - (lines * 14) / 2 + 2 : d.textV === 'bottom' ? y + rh - lines * 14 - 3 : y + 4
          ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
          drawText(ctx, d.text, tx, ty, rw - 10)
          ctx.textAlign = 'left'
        }
      }
      if (selected) {
        handle(ctx, xa, ya, d.color)
        handle(ctx, xb, yb, d.color)
      }
    }

    for (const d of engine.drawings) drawOne(d, d.id === selRef.current)

    // in-progress preview
    const pending = pendingRef.current
    if (pending?.hover) {
      const kind = toolRef.current
      if (kind === 'trend' || kind === 'rect') {
        ctx.setLineDash([4, 3])
        drawOne({ id: -1, kind, a: pending.a, b: pending.hover, color: colorRef.current }, false)
        ctx.setLineDash([])
      }
    }
    ctx.restore()
  }, [chart, container, engine, timeToX, priceToY])

  /* ---------- hit testing (pixel space) ---------- */

  const hitTest = useCallback((x: number, y: number): { d: Drawing; part: 'a' | 'b' | 'body' } | null => {
    const ds = engine.drawings
    for (let i = ds.length - 1; i >= 0; i--) {
      const d = ds[i]
      const xa = timeToX(d.a.time), ya = priceToY(d.a.price)
      const xb = d.b ? timeToX(d.b.time) : null
      const yb = d.b ? priceToY(d.b.price) : null
      if (d.id === selRef.current && xa !== null && ya !== null) {
        if (Math.hypot(x - xa, y - ya) < HIT) return { d, part: 'a' }
        if (xb !== null && yb !== null && Math.hypot(x - xb, y - yb) < HIT) return { d, part: 'b' }
      }
      if (d.kind === 'hline') {
        if (ya !== null && Math.abs(y - ya) < HIT) return { d, part: 'body' }
      } else if (d.kind === 'text') {
        if (xa !== null && ya !== null && x > xa - HIT && x < xa + 90 && y > ya - HIT && y < ya + 16) return { d, part: 'body' }
      } else if (xa !== null && ya !== null && xb !== null && yb !== null) {
        if (d.kind === 'trend') {
          if (distToSegment(x, y, xa, ya, xb, yb) < HIT) return { d, part: 'body' }
        } else {
          const x1 = Math.min(xa, xb), x2 = Math.max(xa, xb), y1 = Math.min(ya, yb), y2 = Math.max(ya, yb)
          const onBorder =
            (Math.abs(x - x1) < HIT || Math.abs(x - x2) < HIT) && y > y1 - HIT && y < y2 + HIT ||
            (Math.abs(y - y1) < HIT || Math.abs(y - y2) < HIT) && x > x1 - HIT && x < x2 + HIT
          const inside = x > x1 && x < x2 && y > y1 && y < y2
          if (onBorder || inside) return { d, part: 'body' }
        }
      }
    }
    return null
  }, [engine, timeToX, priceToY])

  /* ---------- pointer interaction (capture phase) ---------- */

  useEffect(() => {
    const pos = (e: PointerEvent) => {
      const r = container.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const isOwnUi = (e: Event) =>
      (toolbarRef.current && toolbarRef.current.contains(e.target as Node)) ||
      (editorRef.current && editorRef.current.parentElement?.contains(e.target as Node))

    const consume = (e: Event) => { e.stopPropagation(); e.preventDefault() }
    const lockChart = (lock: boolean) => chart.applyOptions({ handleScroll: !lock, handleScale: !lock })

    const onDown = (e: PointerEvent) => {
      if (isOwnUi(e)) return
      const { x, y } = pos(e)
      const t = toolRef.current
      if (editing) setEditing(null)

      if (t !== 'cursor') {
        consume(e)
        const anchor = pointToAnchor(x, y)
        if (!anchor) return
        if (t === 'hline') {
          const d: Drawing = { id: nextDrawingId(), kind: 'hline', a: anchor, color: colorRef.current }
          engine.drawings.push(d)
          setSelectedId(d.id)
          setTool('cursor')
        } else if (t === 'text') {
          setEditing({ x, y, anchor, value: '' })
          setTool('cursor')
        } else if (!pendingRef.current) {
          pendingRef.current = { a: anchor, hover: anchor }
          lockChart(true)
        } else {
          const d: Drawing = { id: nextDrawingId(), kind: t, a: pendingRef.current.a, b: anchor, color: colorRef.current }
          engine.drawings.push(d)
          pendingRef.current = null
          lockChart(false)
          setSelectedId(d.id)
          setTool('cursor')
        }
        redraw()
        return
      }

      const hit = hitTest(x, y)
      if (hit) {
        consume(e)
        container.setPointerCapture(e.pointerId)
        lockChart(true)
        setSelectedId(hit.d.id)
        if (hit.part === 'body') {
          dragRef.current = { mode: 'move', id: hit.d.id, startX: x, startY: y, origA: { ...hit.d.a }, origB: hit.d.b && { ...hit.d.b } }
        } else {
          dragRef.current = { mode: hit.part, id: hit.d.id }
        }
        redraw()
      } else if (selRef.current !== null) {
        setSelectedId(null)
        redraw()
      }
    }

    const onMove = (e: PointerEvent) => {
      if (isOwnUi(e)) return
      const { x, y } = pos(e)
      const pending = pendingRef.current
      if (pending) {
        consume(e)
        pending.hover = pointToAnchor(x, y)
        redraw()
        return
      }
      const drag = dragRef.current
      if (!drag) return
      consume(e)
      const d = engine.drawings.find(dd => dd.id === drag.id)
      if (!d) { dragRef.current = null; return }
      if (drag.mode === 'move') {
        const bars = getBars()
        const barSpacing = (chart.timeScale().options() as { barSpacing: number }).barSpacing || 8
        const dIdx = Math.round((x - drag.startX) / barSpacing)
        const p0 = series.coordinateToPrice(drag.startY)
        const p1 = series.coordinateToPrice(y)
        const dPrice = p0 !== null && p1 !== null ? +p1 - +p0 : 0
        const shift = (a: Anchor): Anchor => {
          const idx = Math.max(0, Math.min(bars.length - 1, nearestIndex(bars, a.time) + dIdx))
          return { time: bars.length ? bars[idx].time : a.time, price: a.price + dPrice }
        }
        d.a = shift(drag.origA)
        if (drag.origB) d.b = shift(drag.origB)
      } else {
        const anchor = pointToAnchor(x, y)
        if (anchor) {
          if (drag.mode === 'a') d.a = anchor
          else if (d.b) d.b = anchor
        }
      }
      redraw()
    }

    const onUp = (e: PointerEvent) => {
      if (dragRef.current) {
        dragRef.current = null
        chart.applyOptions({ handleScroll: true, handleScale: true })
        try { container.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
        consume(e)
      }
    }

    const onDblClick = (e: MouseEvent) => {
      if (isOwnUi(e)) return
      const r = container.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      const hit = hitTest(x, y)
      if (!hit) return
      consume(e)
      setSelectedId(hit.d.id)
      setEditing({ x, y, id: hit.d.id, value: hit.d.text ?? '' })
    }

    container.addEventListener('pointerdown', onDown, true)
    container.addEventListener('pointermove', onMove, true)
    container.addEventListener('pointerup', onUp, true)
    container.addEventListener('dblclick', onDblClick, true)
    return () => {
      container.removeEventListener('pointerdown', onDown, true)
      container.removeEventListener('pointermove', onMove, true)
      container.removeEventListener('pointerup', onUp, true)
      container.removeEventListener('dblclick', onDblClick, true)
    }
  }, [chart, container, engine, series, getBars, pointToAnchor, hitTest, redraw, editing])

  /* ---------- keyboard: delete / escape ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if ((e.code === 'Delete' || e.code === 'Backspace') && selRef.current !== null) {
        e.preventDefault()
        engine.drawings = engine.drawings.filter(d => d.id !== selRef.current)
        setSelectedId(null)
        redraw()
      } else if (e.code === 'Escape') {
        pendingRef.current = null
        chart.applyOptions({ handleScroll: true, handleScale: true })
        setTool('cursor')
        setSelectedId(null)
        setEditing(null)
        redraw()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, chart, redraw])

  /* ---------- redraw triggers ---------- */

  useEffect(() => {
    const ts = chart.timeScale()
    const onRange = () => redraw()
    ts.subscribeVisibleLogicalRangeChange(onRange)
    const unsubEngine = engine.subscribe(redraw)
    const ro = new ResizeObserver(redraw)
    ro.observe(container)
    redraw()
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRange)
      unsubEngine()
      ro.disconnect()
    }
  }, [chart, container, engine, redraw])

  useEffect(() => { redraw() }, [dataVersion, selectedId, tool, redraw])
  useEffect(() => { onCanvas(canvasRef.current); return () => onCanvas(null) }, [onCanvas])
  useEffect(() => {
    container.style.cursor = tool === 'cursor' ? '' : 'crosshair'
    return () => { container.style.cursor = '' }
  }, [tool, container])
  useEffect(() => { editorRef.current?.focus() }, [editing])

  /* ---------- text editor commit ---------- */

  const commitEditing = () => {
    if (!editing) return
    const value = editing.value.trim()
    if (editing.id !== undefined) {
      const d = engine.drawings.find(dd => dd.id === editing.id)
      if (d) d.text = value || undefined
    } else if (editing.anchor && value) {
      const d: Drawing = { id: nextDrawingId(), kind: 'text', a: editing.anchor, color: colorRef.current, text: value }
      engine.drawings.push(d)
      setSelectedId(d.id)
    }
    setEditing(null)
    redraw()
  }

  const recolorSelected = (c: string) => {
    setColor(c)
    if (selRef.current !== null) {
      const d = engine.drawings.find(dd => dd.id === selRef.current)
      if (d) { d.color = c; redraw() }
    }
  }

  const TOOLS: { key: Tool; icon: string; title: string }[] = [
    { key: 'cursor', icon: '⊹', title: 'Select / move (Esc)' },
    { key: 'trend', icon: '╱', title: 'Trendline — click start, click end' },
    { key: 'rect', icon: '▭', title: 'Rectangle — click two corners, double-click to write in it' },
    { key: 'hline', icon: '─', title: 'Horizontal line' },
    { key: 'text', icon: 'T', title: 'Text note' },
  ]

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 z-[3] pointer-events-none" style={{ width: '100%', height: '100%' }} />
      <div ref={toolbarRef} className="absolute left-1.5 top-1.5 z-[5] flex flex-col gap-1 bg-surface/90 border border-white/10 rounded-lg p-1">
        {TOOLS.map(t => (
          <button
            key={t.key}
            title={t.title}
            className={`w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
              tool === t.key ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/10'
            }`}
            onClick={() => { pendingRef.current = null; setTool(t.key) }}
          >
            {t.icon}
          </button>
        ))}
        <div className="h-px bg-hairline my-0.5" />
        {DRAW_COLORS.map(c => (
          <button
            key={c}
            title="Color (applies to selected drawing too)"
            className={`w-7 h-5 rounded-md flex items-center justify-center ${color === c ? 'bg-white/15' : 'hover:bg-white/10'}`}
            onClick={() => recolorSelected(c)}
          >
            <span className="w-3.5 h-3.5 rounded-full border border-black/40" style={{ background: c }} />
          </button>
        ))}
        <div className="h-px bg-hairline my-0.5" />
        <button
          title="Delete selected (Del)"
          className="w-7 h-7 rounded-md text-sm text-ink2 hover:bg-white/10 disabled:opacity-30"
          disabled={selectedId === null}
          onClick={() => {
            engine.drawings = engine.drawings.filter(d => d.id !== selectedId)
            setSelectedId(null)
            redraw()
          }}
        >
          🗑
        </button>
        <button
          title="Clear all drawings"
          className="w-7 h-7 rounded-md text-xs text-ink2 hover:bg-white/10 disabled:opacity-30"
          disabled={!engine.drawings.length}
          onClick={() => {
            if (confirm('Remove all drawings?')) { engine.drawings = []; setSelectedId(null); redraw() }
          }}
        >
          ✕
        </button>
      </div>
      {editing && (() => {
        const target = editing.id !== undefined ? engine.drawings.find(dd => dd.id === editing.id) : undefined
        const showAlign = target && target.kind !== 'text'
        const setAlign = (patch: { textH?: TextH; textV?: TextV }) => {
          if (!target) return
          Object.assign(target, patch)
          redraw()
          editorRef.current?.focus()
        }
        return (
          <div
            className="absolute z-[6] bg-surface border border-white/15 rounded-lg p-1.5 shadow-xl"
            style={{ left: Math.min(editing.x, container.clientWidth - 210), top: Math.min(editing.y, container.clientHeight - 110) }}
          >
            <textarea
              ref={editorRef}
              rows={2}
              className="input !w-44 text-xs"
              placeholder="Type… (Enter to save)"
              value={editing.value}
              onChange={e => setEditing(ed => ed && { ...ed, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEditing() }
                else if (e.key === 'Escape') setEditing(null)
              }}
              onBlur={e => {
                // keep the editor open when clicking its own alignment buttons
                if (!(e.relatedTarget && e.currentTarget.parentElement?.contains(e.relatedTarget as Node))) commitEditing()
              }}
            />
            {showAlign && (
              <div className="flex items-center gap-1 mt-1 text-[10px] text-muted">
                <span>Text:</span>
                {(['left', 'center', 'right'] as TextH[]).map(hv => (
                  <button
                    key={hv}
                    className={`px-1.5 py-0.5 rounded ${(target.textH ?? 'left') === hv ? 'bg-accent text-white' : 'bg-white/5 hover:bg-white/10'}`}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setAlign({ textH: hv })}
                  >
                    {hv === 'left' ? '⇤' : hv === 'center' ? '↔' : '⇥'}
                  </button>
                ))}
                <span className="w-1" />
                {(['top', 'middle', 'bottom'] as TextV[]).map(vv => (
                  <button
                    key={vv}
                    className={`px-1.5 py-0.5 rounded ${(target.textV ?? 'top') === vv ? 'bg-accent text-white' : 'bg-white/5 hover:bg-white/10'}`}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setAlign({ textV: vv })}
                  >
                    {vv === 'top' ? '⇡' : vv === 'middle' ? '↕' : '⇣'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })()}
    </>
  )
}

/* ---------- canvas helpers ---------- */

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save()
  ctx.fillStyle = '#1a1a19'
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(x, y, 4.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (maxWidth !== undefined && maxWidth > 20) ctx.fillText(line, x, y + i * 14, maxWidth)
    else ctx.fillText(line, x, y + i * 14)
  })
}
