// TradingView-style drawing overlay for the replay chart.
// Rendering: a pointer-events-none canvas above the chart. Interaction: capture-phase
// pointer listeners on the chart container — when a tool is active or a drawing is hit,
// the event is consumed (stopPropagation) so the chart doesn't pan underneath.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts'
import type { Bar } from '../lib/types'
import type { IReplayView } from '../replay/engine'
import { getSetting, setSetting } from '../db'
import {
  DRAW_COLORS, distToSegment, nearestIndex, nextDrawingId,
  type Anchor, type Drawing, type TextH, type TextV, type Tool,
} from '../replay/drawings'

// TradingView-style magnet. off = free cursor. weak = snap only when the
// cursor is within WEAK_MAGNET_PX of an OHLC line. strong = always snap to
// the nearest of the bar's four prices. Persisted across sessions.
type MagnetMode = 'off' | 'weak' | 'strong'
const WEAK_MAGNET_PX = 20
const MAGNET_STORAGE_KEY = 'drawingMagnetMode'

interface Props {
  container: HTMLElement
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  engine: IReplayView
  getBars: () => Bar[]
  dataVersion: number
  onCanvas: (c: HTMLCanvasElement | null) => void
}

type DragState =
  | { mode: 'move'; id: number; startX: number; startY: number; origA: Anchor; origB?: Anchor }
  | { mode: 'a' | 'b'; id: number }
  | { mode: 'left' | 'right'; id: number } // rect side-edge drag: moves the anchor sitting on that side

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
  const [magnet, setMagnet] = useState<MagnetMode>('off')
  const pendingRef = useRef<{ a: Anchor; hover: Anchor | null } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const selRef = useRef(selectedId)
  const magnetRef = useRef(magnet)
  toolRef.current = tool
  colorRef.current = color
  selRef.current = selectedId
  magnetRef.current = magnet

  // Persist magnet mode. Read once on mount; write on every change.
  useEffect(() => {
    void getSetting<MagnetMode>(MAGNET_STORAGE_KEY, 'off').then(m => {
      if (m === 'off' || m === 'weak' || m === 'strong') setMagnet(m)
    })
  }, [])
  useEffect(() => { void setSetting(MAGNET_STORAGE_KEY, magnet) }, [magnet])

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

  /**
   * TradingView-style magnet: when the mouse is near a candle's O/H/L/C, force
   * the anchor's price to that exact value. `weak` snaps only if the cursor Y
   * is within WEAK_MAGNET_PX of one of the four price lines; `strong` always
   * snaps to whichever of the four is closest. Time is left alone — it's
   * already snapped to the candle's index by pointToAnchor.
   */
  const snapAnchor = useCallback((x: number, y: number, a: Anchor): Anchor => {
    const mode = magnetRef.current
    if (mode === 'off') return a
    const bars = getBars()
    if (!bars.length) return a
    const idx = nearestIndex(bars, a.time)
    const bar = bars[idx]
    if (!bar) return a
    const options = [bar.high, bar.low, bar.open, bar.close]
    let bestPrice = options[0]
    let bestDistPx = Infinity
    for (const p of options) {
      const py = series.priceToCoordinate(p)
      if (py === null) continue
      const dPx = Math.abs(py - y)
      if (dPx < bestDistPx) { bestDistPx = dPx; bestPrice = p }
    }
    if (mode === 'weak' && bestDistPx > WEAK_MAGNET_PX) return a
    return { time: a.time, price: bestPrice }
  }, [getBars, series])

  const pointToSnappedAnchor = useCallback((x: number, y: number): Anchor | null => {
    const a = pointToAnchor(x, y)
    return a ? snapAnchor(x, y, a) : null
  }, [pointToAnchor, snapAnchor])

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
        // Rect: extend flags override the horizontal edges to pane boundaries.
        const anchorLeftX = Math.min(xa, xb), anchorRightX = Math.max(xa, xb)
        const xLeft = d.extendLeft ? 0 : anchorLeftX
        const xRight = d.extendRight ? paneW : anchorRightX
        const y = Math.min(ya, yb)
        const rw = xRight - xLeft, rh = Math.abs(yb - ya)
        ctx.globalAlpha = 0.13
        ctx.fillRect(xLeft, y, rw, rh)
        ctx.globalAlpha = 1
        ctx.strokeRect(xLeft, y, rw, rh)
        if (d.text) {
          const lines = d.text.split('\n').length
          const tx = d.textH === 'center' ? xLeft + rw / 2 : d.textH === 'right' ? xLeft + rw - 5 : xLeft + 5
          const ty = d.textV === 'middle' ? y + rh / 2 - (lines * 14) / 2 + 2 : d.textV === 'bottom' ? y + rh - lines * 14 - 3 : y + 4
          ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
          drawText(ctx, d.text, tx, ty, rw - 10)
          ctx.textAlign = 'left'
        }
        if (selected) {
          // Corner handles at the actual anchor positions (not the extended edges).
          handle(ctx, xa, ya, d.color)
          handle(ctx, xb, yb, d.color)
          // Side handles: mid-edge circles for extending / dragging horizontally.
          const midY = (ya + yb) / 2
          handle(ctx, xLeft, midY, d.color, !!d.extendLeft)
          handle(ctx, xRight, midY, d.color, !!d.extendRight)
          return
        }
        return
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

  const hitTest = useCallback((x: number, y: number): { d: Drawing; part: 'a' | 'b' | 'body' | 'left' | 'right' } | null => {
    const ds = engine.drawings
    const paneW = chart.timeScale().width()
    for (let i = ds.length - 1; i >= 0; i--) {
      const d = ds[i]
      const xa = timeToX(d.a.time), ya = priceToY(d.a.price)
      const xb = d.b ? timeToX(d.b.time) : null
      const yb = d.b ? priceToY(d.b.price) : null
      if (d.id === selRef.current && xa !== null && ya !== null) {
        // Rect side handles first — they sit at pane edges when extended and
        // should intercept before the underlying border hit.
        if (d.kind === 'rect' && xb !== null && yb !== null) {
          const anchorLeftX = Math.min(xa, xb), anchorRightX = Math.max(xa, xb)
          const xLeft = d.extendLeft ? 0 : anchorLeftX
          const xRight = d.extendRight ? paneW : anchorRightX
          const midY = (ya + yb) / 2
          if (Math.hypot(x - xLeft, y - midY) < HIT) return { d, part: 'left' }
          if (Math.hypot(x - xRight, y - midY) < HIT) return { d, part: 'right' }
        }
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
          const anchorLeftX = Math.min(xa, xb), anchorRightX = Math.max(xa, xb)
          const x1 = d.extendLeft ? 0 : anchorLeftX
          const x2 = d.extendRight ? paneW : anchorRightX
          const y1 = Math.min(ya, yb), y2 = Math.max(ya, yb)
          const onBorder =
            (Math.abs(x - x1) < HIT || Math.abs(x - x2) < HIT) && y > y1 - HIT && y < y2 + HIT ||
            (Math.abs(y - y1) < HIT || Math.abs(y - y2) < HIT) && x > x1 - HIT && x < x2 + HIT
          const inside = x > x1 && x < x2 && y > y1 && y < y2
          if (onBorder || inside) return { d, part: 'body' }
        }
      }
    }
    return null
  }, [engine, chart, timeToX, priceToY])

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
        const anchor = pointToSnappedAnchor(x, y)
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
        pending.hover = pointToSnappedAnchor(x, y)
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
      } else if (drag.mode === 'left' || drag.mode === 'right') {
        // Rect side-edge drag: only the time of whichever anchor sits on that
        // side is updated (price stays put). If the rect was extended on that
        // side, dragging turns the extension off — matches TradingView UX.
        if (d.kind !== 'rect' || !d.b) return
        const anchor = pointToSnappedAnchor(x, y)
        if (!anchor) return
        const xa = timeToX(d.a.time)
        const xb = timeToX(d.b.time)
        if (xa === null || xb === null) return
        // Which anchor is currently on the drag side?
        const wantMax = drag.mode === 'right'
        const aIsSide = wantMax ? xa >= xb : xa <= xb
        if (aIsSide) d.a = { ...d.a, time: anchor.time }
        else d.b = { ...d.b, time: anchor.time }
        if (drag.mode === 'left') d.extendLeft = false
        else d.extendRight = false
      } else {
        const anchor = pointToSnappedAnchor(x, y)
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
  }, [chart, container, engine, series, getBars, pointToSnappedAnchor, hitTest, redraw, editing])

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

  // lightweight-charts' price scale has no change-subscription API at all, so dragging
  // the right-hand axis to rescale vertically (or any other future scale-changing
  // gesture) never fires a redraw on its own — keep repainting every frame while any
  // pointer button is held down anywhere, so drawings never visibly detach mid-drag.
  useEffect(() => {
    let raf: number | null = null
    const loop = () => { redraw(); raf = requestAnimationFrame(loop) }
    const onPointerDown = () => { if (raf === null) raf = requestAnimationFrame(loop) }
    const onPointerUp = () => { if (raf !== null) { cancelAnimationFrame(raf); raf = null } }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [redraw])

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

  // Selected rectangle (if any) — powers the visibility + state of the extend
  // buttons at the bottom of the toolbar.
  const selectedRect = selectedId !== null
    ? engine.drawings.find(d => d.id === selectedId && d.kind === 'rect')
    : undefined

  const toggleExtend = (side: 'left' | 'right' | 'both') => {
    if (!selectedRect) return
    if (side === 'both') {
      const on = !(selectedRect.extendLeft && selectedRect.extendRight)
      selectedRect.extendLeft = on
      selectedRect.extendRight = on
    } else if (side === 'left') {
      selectedRect.extendLeft = !selectedRect.extendLeft
    } else {
      selectedRect.extendRight = !selectedRect.extendRight
    }
    redraw()
  }

  const TOOLS: { key: Tool; icon: string; title: string }[] = [
    { key: 'cursor', icon: '⊹', title: 'Select / move (Esc)' },
    { key: 'trend', icon: '╱', title: 'Trendline — click start, click end' },
    { key: 'rect', icon: '▭', title: 'Rectangle — click two corners, double-click to write in it' },
    { key: 'hline', icon: '─', title: 'Horizontal line' },
    { key: 'text', icon: 'T', title: 'Text note' },
  ]

  const magnetNext: Record<MagnetMode, MagnetMode> = { off: 'weak', weak: 'strong', strong: 'off' }
  const magnetLabel: Record<MagnetMode, string> = {
    off: 'Magnet: off — click to enable weak snap',
    weak: 'Magnet: weak — snaps to OHLC when cursor is near a price line (click to switch to strong)',
    strong: 'Magnet: strong — always snaps to nearest OHLC of the bar under cursor (click to turn off)',
  }

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
          title={magnetLabel[magnet]}
          className={`w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
            magnet === 'off' ? 'text-ink2 hover:bg-white/10' : magnet === 'weak' ? 'bg-warn/25 text-warn' : 'bg-accent text-white'
          }`}
          onClick={() => setMagnet(m => magnetNext[m])}
        >
          🧲
        </button>
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
        {selectedRect && (
          <>
            <div className="h-px bg-hairline my-0.5" />
            <button
              title="Extend rectangle left to the pane edge"
              className={`w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
                selectedRect.extendLeft ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/10'
              }`}
              onClick={() => toggleExtend('left')}
            >
              ⇤
            </button>
            <button
              title="Extend rectangle right to the pane edge (great for open zones)"
              className={`w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
                selectedRect.extendRight ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/10'
              }`}
              onClick={() => toggleExtend('right')}
            >
              ⇥
            </button>
            <button
              title="Extend both sides to the pane edges"
              className={`w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
                selectedRect.extendLeft && selectedRect.extendRight ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/10'
              }`}
              onClick={() => toggleExtend('both')}
            >
              ⇹
            </button>
          </>
        )}
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

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, filled = false) {
  ctx.save()
  ctx.fillStyle = filled ? color : '#1a1a19'
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
