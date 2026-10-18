// Drawing layer over the replay chart: a canvas for the drawings themselves, a
// tool rail, and the pointer/keyboard handling that makes them feel like a real
// charting package — eight-handle rectangles, hover affordances, resize cursors,
// undo/redo, a right-click menu and per-drawing styling.
//
// Geometry and the handle model live in src/replay/drawings.ts so the renderer,
// the hit test and the drag logic all read from one definition.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts'
import type { Bar } from '../lib/types'
import type { IReplayView } from '../replay/engine'
import { getSetting, setSetting } from '../db'
import { fmtPx } from '../lib/symbols'
import {
  DRAW_COLORS, FIB_LEVELS, KIND_LABEL, LINE_STYLES, LINE_WIDTHS, TWO_POINT,
  cloneDrawings, constrain, dashFor, distToSegment, extendSegment, geomOf, handlesFor,
  nearestIndex, nextDrawingId, resizeByPart,
  type Anchor, type DrawKind, type Drawing, type Geom, type HandlePart, type HitPart,
  type LineStyle, type TextH, type TextV, type Tool,
} from '../replay/drawings'

type MagnetMode = 'off' | 'weak' | 'strong'
const WEAK_MAGNET_PX = 20
const MAGNET_STORAGE_KEY = 'drawingMagnetMode'
const STAY_STORAGE_KEY = 'drawingStayInTool'
const HIT = 7
const HANDLE_HIT = 8
const MAX_UNDO = 100

/**
 * The chart library writes its own `style.cursor` on the container after our
 * capture-phase handler runs, so an inline cursor never survives. A class with
 * Tailwind's important modifier does. Spelled out as literals so the Tailwind
 * scanner emits them.
 */
const CURSOR_CLASS: Record<HitPart, string> = {
  body: '!cursor-move',
  mid: '!cursor-move',
  a: '!cursor-pointer',
  b: '!cursor-pointer',
  n: '!cursor-ns-resize',
  s: '!cursor-ns-resize',
  e: '!cursor-ew-resize',
  w: '!cursor-ew-resize',
  nw: '!cursor-nwse-resize',
  se: '!cursor-nwse-resize',
  ne: '!cursor-nesw-resize',
  sw: '!cursor-nesw-resize',
}
const ALL_CURSOR_CLASSES = Object.values(CURSOR_CLASS)

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
  | { mode: 'move'; id: number; startX: number; startY: number; origA: Anchor; origB?: Anchor; moved: boolean }
  | { mode: 'handle'; id: number; part: HandlePart; moved: boolean }

interface Editing {
  x: number
  y: number
  id?: number
  anchor?: Anchor
  value: string
}

interface Menu {
  x: number
  y: number
  id: number
}

export default function DrawingLayer({ container, chart, series, engine, getBars, dataVersion, onCanvas }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<Tool>('cursor')
  const [color, setColor] = useState(DRAW_COLORS[0])
  const [width, setWidth] = useState(1)
  const [style, setStyle] = useState<LineStyle>('solid')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [magnet, setMagnet] = useState<MagnetMode>('off')
  const [stayInTool, setStayInTool] = useState(false)
  const [, setTick] = useState(0)

  const pendingRef = useRef<{ a: Anchor; hover: Anchor | null } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const dragSnapRef = useRef<Drawing[] | null>(null)
  const hoverRef = useRef<{ id: number; part: HitPart } | null>(null)
  const shiftRef = useRef(false)
  const undoRef = useRef<Drawing[][]>([])
  const redoRef = useRef<Drawing[][]>([])
  const clipboardRef = useRef<Drawing | null>(null)

  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const widthRef = useRef(width)
  const styleRef = useRef(style)
  const selRef = useRef(selectedId)
  const magnetRef = useRef(magnet)
  const stayRef = useRef(stayInTool)
  toolRef.current = tool
  colorRef.current = color
  widthRef.current = width
  styleRef.current = style
  selRef.current = selectedId
  magnetRef.current = magnet
  stayRef.current = stayInTool

  const selected = engine.drawings.find(d => d.id === selectedId) ?? null

  useEffect(() => {
    void getSetting<MagnetMode>(MAGNET_STORAGE_KEY, 'off').then(m => {
      if (m === 'off' || m === 'weak' || m === 'strong') setMagnet(m)
    })
    void getSetting<boolean>(STAY_STORAGE_KEY, false).then(setStayInTool)
  }, [])
  useEffect(() => { void setSetting(MAGNET_STORAGE_KEY, magnet) }, [magnet])
  useEffect(() => { void setSetting(STAY_STORAGE_KEY, stayInTool) }, [stayInTool])

  /* ---------- history ---------- */

  const snapshot = useCallback(() => cloneDrawings(engine.drawings), [engine])

  /** Record the state *before* a change. Call it immediately prior to mutating. */
  const commit = useCallback(() => {
    undoRef.current.push(snapshot())
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift()
    redoRef.current.length = 0
    setTick(t => t + 1) // the undo/redo buttons read the stacks
  }, [snapshot])

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
   * Magnet: when the mouse is near a candle's O/H/L/C, force the anchor's price
   * to that exact value. `weak` snaps only within WEAK_MAGNET_PX of a price
   * line; `strong` always snaps to the closest of the four. Time is already
   * snapped to the candle index by pointToAnchor.
   */
  const snapAnchor = useCallback((x: number, y: number, a: Anchor): Anchor => {
    const mode = magnetRef.current
    if (mode === 'off') return a
    const bars = getBars()
    if (!bars.length) return a
    const bar = bars[nearestIndex(bars, a.time)]
    if (!bar) return a
    let bestPrice = bar.high
    let bestDistPx = Infinity
    for (const p of [bar.high, bar.low, bar.open, bar.close]) {
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

  /** Resolve a drawing to pixels. Null when it can't be placed on screen. */
  const geomFor = useCallback((d: Drawing, paneW: number, paneH: number): Geom | null => {
    const xa = timeToX(d.a.time), ya = priceToY(d.a.price)
    if (d.kind === 'hline') return ya === null ? null : geomOf(d, 0, ya, null, null, paneW, paneH)
    if (xa === null) return null
    if (d.kind === 'vline') return geomOf(d, xa, 0, null, null, paneW, paneH)
    if (ya === null) return null
    if (!d.b) return geomOf(d, xa, ya, null, null, paneW, paneH)
    const xb = timeToX(d.b.time), yb = priceToY(d.b.price)
    if (xb === null || yb === null) return null
    return geomOf(d, xa, ya, xb, yb, paneW, paneH)
  }, [timeToX, priceToY])

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

    const symbol = engine.config.symbol
    const hover = hoverRef.current

    const drawOne = (d: Drawing, isSelected: boolean, preview = false) => {
      const g = geomFor(d, paneW, paneH)
      if (!g) return
      const lw = d.width ?? 1
      const hovered = !preview && hover?.id === d.id
      ctx.strokeStyle = d.color
      ctx.fillStyle = d.color
      ctx.lineWidth = lw
      ctx.setLineDash(preview ? [4, 3] : dashFor(d.style, lw))
      ctx.font = '11px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      // A hovered-but-unselected drawing gets a faint halo, so you can tell what
      // you're about to grab before you click. The halo pass strokes outlines
      // only — fills and labels would otherwise be drawn twice.
      const haloPass = hovered && !isSelected
      let halo = false

      const strokeBody = () => {
        switch (d.kind) {
          case 'hline':
            ctx.beginPath(); ctx.moveTo(0, g.ya); ctx.lineTo(paneW, g.ya); ctx.stroke(); break
          case 'vline':
            ctx.beginPath(); ctx.moveTo(g.xa, 0); ctx.lineTo(g.xa, paneH); ctx.stroke(); break
          case 'trend': case 'ray': case 'extended': {
            if (g.xb === null || g.yb === null) break
            const [x1, y1, x2, y2] = extendSegment(d.kind, g.xa, g.ya, g.xb, g.yb, paneW, paneH)
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); break
          }
          case 'rect': {
            if (g.xb === null || g.yb === null) break
            const rw = g.xRight - g.xLeft, rh = g.yBottom - g.yTop
            if (!halo) {
              ctx.save()
              ctx.globalAlpha = d.fillOpacity ?? 0.13
              ctx.setLineDash([])
              ctx.fillRect(g.xLeft, g.yTop, rw, rh)
              ctx.restore()
            }
            ctx.strokeRect(g.xLeft, g.yTop, rw, rh)
            break
          }
          case 'fib': {
            if (g.xb === null || g.yb === null) break
            const x1 = Math.min(g.xa, g.xb)
            const x2 = paneW
            const lo = d.a.price, hi = d.b!.price
            let prevY: number | null = null
            for (const lvl of FIB_LEVELS) {
              const price = lo + (hi - lo) * lvl
              const y = priceToY(price)
              if (y === null) continue
              if (prevY !== null && !halo) {
                ctx.save()
                ctx.globalAlpha = (d.fillOpacity ?? 0.13) * 0.5
                ctx.setLineDash([])
                ctx.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY))
                ctx.restore()
              }
              prevY = y
              ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke()
              if (!preview && !halo) {
                ctx.save()
                ctx.setLineDash([])
                ctx.textAlign = 'left'
                drawText(ctx, `${lvl.toFixed(3)}  ${fmtPx(price, symbol)}`, x1 + 4, y - 13)
                ctx.restore()
              }
            }
            // The leg itself, dashed, so the retracement's direction reads.
            ctx.save()
            ctx.setLineDash([3, 3])
            ctx.globalAlpha = 0.6
            ctx.beginPath(); ctx.moveTo(g.xa, g.ya); ctx.lineTo(g.xb, g.yb); ctx.stroke()
            ctx.restore()
            break
          }
          case 'text':
            ctx.beginPath(); ctx.arc(g.xa, g.ya, 2, 0, Math.PI * 2); ctx.fill()
            break
        }
      }

      if (haloPass) {
        halo = true
        ctx.save()
        ctx.globalAlpha = 0.25
        ctx.lineWidth = lw + 6
        strokeBody()
        ctx.restore()
        halo = false
      }
      strokeBody()
      ctx.setLineDash([])

      // text label
      if (d.kind === 'text') {
        drawText(ctx, d.text || '…', g.xa + 5, g.ya - 6)
      } else if (d.text) {
        placeLabel(ctx, d, g, paneW)
      }

      if (isSelected && !preview) {
        for (const hp of handlesFor(d, g)) {
          handleDot(ctx, hp.x, hp.y, d.color, hover?.part === hp.part && hover.id === d.id)
        }
      }
    }

    for (const d of engine.drawings) drawOne(d, d.id === selRef.current)

    // in-progress preview plus a live readout of what you're drawing
    const pending = pendingRef.current
    if (pending?.hover) {
      const kind = toolRef.current as DrawKind
      if (TWO_POINT.includes(kind)) {
        const ghost: Drawing = {
          id: -1, kind, a: pending.a, b: pending.hover,
          color: colorRef.current, width: widthRef.current, style: styleRef.current,
        }
        drawOne(ghost, false, true)
        drawReadout(ctx, ghost, paneW, paneH)
      }
    }
    ctx.restore()

    /** Δ price / % / bar count next to the cursor while dragging out a shape. */
    function drawReadout(c: CanvasRenderingContext2D, d: Drawing, pw: number, ph: number) {
      if (!d.b) return
      const g = geomFor(d, pw, ph)
      if (!g || g.xb === null || g.yb === null) return
      const bars = getBars()
      const nBars = Math.abs(nearestIndex(bars, d.b.time) - nearestIndex(bars, d.a.time))
      const dPrice = d.b.price - d.a.price
      const pct = d.a.price ? (dPrice / d.a.price) * 100 : 0
      const lines = [
        `${dPrice >= 0 ? '+' : ''}${fmtPx(dPrice, symbol)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
        `${nBars} bar${nBars === 1 ? '' : 's'}`,
      ]
      c.save()
      c.font = '11px system-ui, sans-serif'
      c.textBaseline = 'top'
      c.textAlign = 'left'
      const wText = Math.max(...lines.map(l => c.measureText(l).width))
      let bx = g.xb + 12, by = g.yb + 12
      if (bx + wText + 10 > pw) bx = g.xb - wText - 22
      if (by + 32 > ph) by = g.yb - 42
      c.fillStyle = 'rgba(14,16,20,0.92)'
      c.strokeStyle = 'rgba(255,255,255,0.14)'
      c.lineWidth = 1
      roundRect(c, bx - 6, by - 5, wText + 14, 32, 4)
      c.fill(); c.stroke()
      c.fillStyle = '#e8e6df'
      lines.forEach((l, i) => c.fillText(l, bx, by + i * 14))
      c.restore()
    }
  }, [chart, container, engine, geomFor, priceToY, getBars])

  /* ---------- hit testing ---------- */

  const hitTest = useCallback((x: number, y: number): { d: Drawing; part: HitPart } | null => {
    const ds = engine.drawings
    const ts = chart.timeScale()
    const paneW = ts.width()
    const paneH = container.clientHeight - ts.height()
    for (let i = ds.length - 1; i >= 0; i--) {
      const d = ds[i]
      if (d.locked) continue
      const g = geomFor(d, paneW, paneH)
      if (!g) continue
      // Handles win over the body, but only while the drawing is selected —
      // otherwise invisible handles would steal clicks from what's underneath.
      if (d.id === selRef.current) {
        for (const hp of handlesFor(d, g)) {
          if (Math.hypot(x - hp.x, y - hp.y) < HANDLE_HIT) return { d, part: hp.part }
        }
      }
      switch (d.kind) {
        case 'hline':
          if (Math.abs(y - g.ya) < HIT) return { d, part: 'body' }
          break
        case 'vline':
          if (Math.abs(x - g.xa) < HIT) return { d, part: 'body' }
          break
        case 'text':
          if (x > g.xa - HIT && x < g.xa + 90 && y > g.ya - HIT && y < g.ya + 16) return { d, part: 'body' }
          break
        case 'trend': case 'ray': case 'extended': {
          if (g.xb === null || g.yb === null) break
          const [x1, y1, x2, y2] = extendSegment(d.kind, g.xa, g.ya, g.xb, g.yb, paneW, paneH)
          if (distToSegment(x, y, x1, y1, x2, y2) < HIT) return { d, part: 'body' }
          break
        }
        case 'fib': {
          if (g.xb === null || g.yb === null) break
          const lo = d.a.price, hi = d.b!.price
          const x1 = Math.min(g.xa, g.xb)
          if (x < x1 - HIT) break
          for (const lvl of FIB_LEVELS) {
            const py = priceToY(lo + (hi - lo) * lvl)
            if (py !== null && Math.abs(y - py) < HIT) return { d, part: 'body' }
          }
          break
        }
        case 'rect': {
          if (g.xb === null || g.yb === null) break
          const { xLeft: x1, xRight: x2, yTop: y1, yBottom: y2 } = g
          const onBorder =
            ((Math.abs(x - x1) < HIT || Math.abs(x - x2) < HIT) && y > y1 - HIT && y < y2 + HIT) ||
            ((Math.abs(y - y1) < HIT || Math.abs(y - y2) < HIT) && x > x1 - HIT && x < x2 + HIT)
          if (onBorder || (x > x1 && x < x2 && y > y1 && y < y2)) return { d, part: 'body' }
          break
        }
      }
    }
    return null
  }, [engine, chart, container, geomFor, priceToY])

  /* ---------- mutations ---------- */

  const removeDrawing = useCallback((id: number) => {
    commit()
    engine.drawings = engine.drawings.filter(d => d.id !== id)
    if (selRef.current === id) setSelectedId(null)
    setMenu(null)
    redraw()
  }, [commit, engine, redraw])

  const duplicateDrawing = useCallback((id: number) => {
    const src = engine.drawings.find(d => d.id === id)
    if (!src) return
    commit()
    const bars = getBars()
    const shift = (a: Anchor): Anchor => {
      const idx = Math.min(bars.length - 1, nearestIndex(bars, a.time) + 2)
      return { time: bars.length ? bars[idx].time : a.time, price: a.price }
    }
    const copy: Drawing = {
      ...src, id: nextDrawingId(),
      a: shift(src.a), b: src.b ? shift(src.b) : undefined,
    }
    engine.drawings.push(copy)
    setSelectedId(copy.id)
    setMenu(null)
    redraw()
  }, [commit, engine, getBars, redraw])

  const patchSelected = useCallback((patch: Partial<Drawing>) => {
    const id = selRef.current
    if (id === null) return
    const d = engine.drawings.find(x => x.id === id)
    if (!d) return
    commit()
    Object.assign(d, patch)
    setTick(t => t + 1)
    redraw()
  }, [commit, engine, redraw])

  const reorder = useCallback((id: number, toFront: boolean) => {
    const i = engine.drawings.findIndex(d => d.id === id)
    if (i < 0) return
    commit()
    const [d] = engine.drawings.splice(i, 1)
    if (toFront) engine.drawings.push(d)
    else engine.drawings.unshift(d)
    setMenu(null)
    redraw()
  }, [commit, engine, redraw])

  const undo = useCallback(() => {
    if (!undoRef.current.length) return
    redoRef.current.push(snapshot())
    engine.drawings = undoRef.current.pop()!
    setSelectedId(null)
    setTick(t => t + 1)
    redraw()
  }, [engine, redraw, snapshot])

  const redo = useCallback(() => {
    if (!redoRef.current.length) return
    undoRef.current.push(snapshot())
    engine.drawings = redoRef.current.pop()!
    setSelectedId(null)
    setTick(t => t + 1)
    redraw()
  }, [engine, redraw, snapshot])

  /* ---------- pointer interaction (capture phase) ---------- */

  useEffect(() => {
    const pos = (e: { clientX: number; clientY: number }) => {
      const r = container.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const isOwnUi = (e: Event) =>
      (toolbarRef.current?.contains(e.target as Node) ?? false) ||
      (menuRef.current?.contains(e.target as Node) ?? false) ||
      (editorRef.current?.parentElement?.contains(e.target as Node) ?? false)

    const consume = (e: Event) => { e.stopPropagation(); e.preventDefault() }
    const setCursor = (part: HitPart | null) => {
      container.classList.remove(...ALL_CURSOR_CLASSES)
      if (part) container.classList.add(CURSOR_CLASS[part])
    }
    const lockChart = (lock: boolean) => chart.applyOptions({ handleScroll: !lock, handleScale: !lock })

    const finishTool = () => {
      if (!stayRef.current) setTool('cursor')
      else pendingRef.current = null
    }

    const onDown = (e: PointerEvent) => {
      if (isOwnUi(e) || e.button === 2) return
      const { x, y } = pos(e)
      const t = toolRef.current
      if (editing) setEditing(null)
      if (menu) setMenu(null)

      if (t !== 'cursor') {
        consume(e)
        const anchor = pointToSnappedAnchor(x, y)
        if (!anchor) return
        const base = { color: colorRef.current, width: widthRef.current, style: styleRef.current }
        if (t === 'hline' || t === 'vline') {
          commit()
          const d: Drawing = { id: nextDrawingId(), kind: t, a: anchor, ...base }
          engine.drawings.push(d)
          setSelectedId(d.id)
          finishTool()
        } else if (t === 'text') {
          setEditing({ x, y, anchor, value: '' })
          finishTool()
        } else if (!pendingRef.current) {
          pendingRef.current = { a: anchor, hover: anchor }
          lockChart(true)
        } else {
          commit()
          const d: Drawing = { id: nextDrawingId(), kind: t, a: pendingRef.current.a, b: anchor, ...base }
          engine.drawings.push(d)
          pendingRef.current = null
          lockChart(false)
          setSelectedId(d.id)
          finishTool()
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
        dragSnapRef.current = snapshot()
        dragRef.current = hit.part === 'body'
          ? { mode: 'move', id: hit.d.id, startX: x, startY: y, origA: { ...hit.d.a }, origB: hit.d.b && { ...hit.d.b }, moved: false }
          : { mode: 'handle', id: hit.d.id, part: hit.part, moved: false }
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
        let a = pointToSnappedAnchor(x, y)
        if (a && shiftRef.current) {
          const xa = timeToX(pending.a.time), ya = priceToY(pending.a.price)
          if (xa !== null && ya !== null) {
            const c = constrain(xa, ya, x, y)
            a = pointToSnappedAnchor(c.x, c.y) ?? a
          }
        }
        pending.hover = a
        redraw()
        return
      }

      const drag = dragRef.current
      if (!drag) {
        // Hover feedback: halo the drawing under the cursor and show the cursor
        // that matches whatever handle it's over.
        const hit = hitTest(x, y)
        const next = hit ? { id: hit.d.id, part: hit.part } : null
        const prev = hoverRef.current
        if (next?.id !== prev?.id || next?.part !== prev?.part) {
          hoverRef.current = next
          setCursor(next?.part ?? null)
          redraw()
        }
        return
      }

      consume(e)
      const d = engine.drawings.find(dd => dd.id === drag.id)
      if (!d) { dragRef.current = null; return }
      drag.moved = true

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
      } else if (drag.part === 'mid') {
        // The middle handle drags the whole drawing, same as grabbing its body.
        const anchor = pointToSnappedAnchor(x, y)
        if (!anchor) return
        if (d.kind === 'hline') d.a = { ...d.a, price: anchor.price }
        else if (d.kind === 'vline') d.a = { ...d.a, time: anchor.time }
        else if (d.b) {
          const midTime = (d.a.time + d.b.time) / 2
          const midPrice = (d.a.price + d.b.price) / 2
          const dt = anchor.time - midTime, dp = anchor.price - midPrice
          const bars = getBars()
          const move = (p: Anchor): Anchor => {
            const idx = Math.max(0, Math.min(bars.length - 1, nearestIndex(bars, p.time + dt)))
            return { time: bars.length ? bars[idx].time : p.time, price: p.price + dp }
          }
          d.a = move(d.a); d.b = move(d.b)
        } else {
          d.a = anchor
        }
      } else {
        const anchor = pointToSnappedAnchor(x, y)
        if (!anchor) return
        if (d.kind === 'hline') d.a = { ...d.a, price: anchor.price }
        else if (d.kind === 'vline') d.a = { ...d.a, time: anchor.time }
        else resizeByPart(d, drag.part, anchor)
      }
      redraw()
    }

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current
      if (drag) {
        // Only record an undo step if something actually moved.
        if (drag.moved && dragSnapRef.current) {
          undoRef.current.push(dragSnapRef.current)
          if (undoRef.current.length > MAX_UNDO) undoRef.current.shift()
          redoRef.current.length = 0
          setTick(t => t + 1)
        }
        dragSnapRef.current = null
        dragRef.current = null
        chart.applyOptions({ handleScroll: true, handleScale: true })
        try { container.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
        consume(e)
      }
    }

    const onDblClick = (e: MouseEvent) => {
      if (isOwnUi(e)) return
      const { x, y } = pos(e)
      const hit = hitTest(x, y)
      if (!hit) return
      consume(e)
      setSelectedId(hit.d.id)
      setEditing({ x, y, id: hit.d.id, value: hit.d.text ?? '' })
    }

    const onContext = (e: MouseEvent) => {
      if (isOwnUi(e)) return
      const { x, y } = pos(e)
      const hit = hitTest(x, y)
      if (!hit) return
      consume(e)
      setSelectedId(hit.d.id)
      setMenu({ x, y, id: hit.d.id })
    }

    const onLeave = () => {
      if (hoverRef.current) { hoverRef.current = null; setCursor(null); redraw() }
    }

    container.addEventListener('pointerdown', onDown, true)
    container.addEventListener('pointermove', onMove, true)
    container.addEventListener('pointerup', onUp, true)
    container.addEventListener('dblclick', onDblClick, true)
    container.addEventListener('contextmenu', onContext, true)
    container.addEventListener('pointerleave', onLeave)
    return () => {
      container.removeEventListener('pointerdown', onDown, true)
      container.removeEventListener('pointermove', onMove, true)
      container.removeEventListener('pointerup', onUp, true)
      container.removeEventListener('dblclick', onDblClick, true)
      container.removeEventListener('contextmenu', onContext, true)
      container.removeEventListener('pointerleave', onLeave)
      container.classList.remove(...ALL_CURSOR_CLASSES)
    }
  }, [chart, container, engine, series, getBars, pointToSnappedAnchor, hitTest, redraw, editing, menu,
      commit, snapshot, timeToX, priceToY])

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const TOOL_KEYS: Record<string, Tool> = {
      KeyT: 'trend', KeyH: 'hline', KeyV: 'vline', KeyR: 'rect',
      KeyF: 'fib', KeyY: 'ray', KeyE: 'extended', KeyX: 'text',
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      shiftRef.current = e.shiftKey
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return }
      if (mod && e.code === 'KeyD' && selRef.current !== null) {
        e.preventDefault(); duplicateDrawing(selRef.current); return
      }
      if (mod && e.code === 'KeyC' && selRef.current !== null) {
        const d = engine.drawings.find(x => x.id === selRef.current)
        if (d) clipboardRef.current = cloneDrawings([d])[0]
        return
      }
      if (mod && e.code === 'KeyV' && clipboardRef.current) {
        e.preventDefault()
        commit()
        const copy = { ...cloneDrawings([clipboardRef.current])[0], id: nextDrawingId() }
        engine.drawings.push(copy)
        setSelectedId(copy.id)
        redraw()
        return
      }
      // Alt + letter picks a tool, the way charting packages tend to.
      if (e.altKey && TOOL_KEYS[e.code]) {
        e.preventDefault()
        pendingRef.current = null
        setTool(TOOL_KEYS[e.code])
        return
      }
      if ((e.code === 'Delete' || e.code === 'Backspace') && selRef.current !== null) {
        e.preventDefault()
        removeDrawing(selRef.current)
      } else if (e.code === 'Escape') {
        pendingRef.current = null
        chart.applyOptions({ handleScroll: true, handleScale: true })
        setTool('cursor')
        setSelectedId(null)
        setEditing(null)
        setMenu(null)
        setShowSettings(false)
        redraw()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => { shiftRef.current = e.shiftKey }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [engine, chart, redraw, undo, redo, duplicateDrawing, removeDrawing, commit])

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

  useEffect(() => { redraw() }, [dataVersion, selectedId, redraw])
  useEffect(() => { onCanvas(canvasRef.current); return () => onCanvas(null) }, [onCanvas])

  /* ---------- text editing ---------- */

  const commitText = () => {
    if (!editing) return
    const v = editing.value.trim()
    commit()
    if (editing.id !== undefined) {
      const d = engine.drawings.find(x => x.id === editing.id)
      if (d) d.text = v || undefined
    } else if (editing.anchor && v) {
      const d: Drawing = {
        id: nextDrawingId(), kind: 'text', a: editing.anchor, text: v,
        color: colorRef.current, width: widthRef.current, style: styleRef.current,
      }
      engine.drawings.push(d)
      setSelectedId(d.id)
    }
    setEditing(null)
    redraw()
  }

  const clearAll = () => {
    if (!engine.drawings.length) return
    commit()
    engine.drawings = []
    setSelectedId(null)
    redraw()
  }

  const TOOLS: { key: Tool; icon: string; title: string }[] = [
    { key: 'cursor', icon: '⊹', title: 'Select / move (Esc)' },
    { key: 'trend', icon: '╱', title: 'Trendline — click start, click end (Alt+T) · hold Shift to constrain' },
    { key: 'ray', icon: '➚', title: 'Ray — extends past the second point (Alt+Y)' },
    { key: 'extended', icon: '✕', title: 'Extended line — runs both ways (Alt+E)' },
    { key: 'hline', icon: '─', title: 'Horizontal line (Alt+H)' },
    { key: 'vline', icon: '│', title: 'Vertical line (Alt+V)' },
    { key: 'rect', icon: '▭', title: 'Rectangle — two corners, double-click to write in it (Alt+R)' },
    { key: 'fib', icon: 'ƒ', title: 'Fib retracement — drag the leg, levels extend right (Alt+F)' },
    { key: 'text', icon: 'T', title: 'Text note (Alt+X)' },
  ]

  const magnetNext: Record<MagnetMode, MagnetMode> = { off: 'weak', weak: 'strong', strong: 'off' }
  const magnetLabel: Record<MagnetMode, string> = {
    off: 'Magnet: off — click to enable weak snap',
    weak: 'Magnet: weak — snaps to OHLC when the cursor is near a price line (click for strong)',
    strong: 'Magnet: strong — always snaps to the nearest OHLC of the bar under the cursor (click to turn off)',
  }

  const railBtn = (on: boolean) =>
    `w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center transition-colors ${
      on ? 'bg-accent text-white' : 'text-ink2 hover:bg-white/10'
    }`

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 z-[3] pointer-events-none" style={{ width: '100%', height: '100%' }} />

      <div ref={toolbarRef} className="absolute left-1.5 top-1.5 z-[5] flex flex-col gap-1 bg-surface/90 border border-white/10 rounded-lg p-1">
        {TOOLS.map(t => (
          <button
            key={t.key}
            title={t.title}
            className={railBtn(tool === t.key)}
            onClick={() => { pendingRef.current = null; setTool(t.key) }}
          >
            {t.icon}
          </button>
        ))}

        <div className="h-px bg-white/10 my-0.5" />

        <div className="grid grid-cols-3 gap-0.5 px-0.5">
          {DRAW_COLORS.map(c => (
            <button
              key={c}
              title="Colour — applies to the selected drawing too"
              className={`w-3.5 h-3.5 rounded-full border ${color === c ? 'border-white' : 'border-white/20'}`}
              style={{ background: c }}
              onClick={() => { setColor(c); if (selRef.current !== null) patchSelected({ color: c }) }}
            />
          ))}
        </div>

        <button
          title="Line width / style, and settings for the selected drawing"
          className={railBtn(showSettings)}
          onClick={() => setShowSettings(v => !v)}
        >≡</button>

        <button
          title={magnetLabel[magnet]}
          className={railBtn(magnet !== 'off')}
          onClick={() => setMagnet(magnetNext[magnet])}
        >
          {magnet === 'strong' ? '🧲' : magnet === 'weak' ? '🧲' : '⌁'}
        </button>

        <button
          title={stayInTool ? 'Staying in the tool after each drawing — click to go back to the cursor each time' : 'Returning to the cursor after each drawing — click to stay in the tool'}
          className={railBtn(stayInTool)}
          onClick={() => setStayInTool(v => !v)}
        >⇄</button>

        <div className="h-px bg-white/10 my-0.5" />

        <button
          title="Undo (Ctrl+Z)"
          className={`${railBtn(false)} disabled:opacity-30`}
          disabled={!undoRef.current.length}
          onClick={undo}
        >↶</button>
        <button
          title="Redo (Ctrl+Shift+Z)"
          className={`${railBtn(false)} disabled:opacity-30`}
          disabled={!redoRef.current.length}
          onClick={redo}
        >↷</button>
        <button
          title="Delete selected (Del)"
          className="w-7 h-7 rounded-md text-sm leading-none flex items-center justify-center text-ink2 hover:bg-white/10 hover:text-down"
          onClick={() => selectedId !== null && removeDrawing(selectedId)}
        >⌫</button>
        <button
          title="Clear all drawings"
          className="w-7 h-7 rounded-md text-xs leading-none flex items-center justify-center text-ink2 hover:bg-white/10 hover:text-down"
          onClick={clearAll}
        >✕✕</button>
      </div>

      {showSettings && (
        <div className="absolute left-11 top-1.5 z-[6] w-52 bg-surface border border-white/10 rounded-lg p-2.5 space-y-2.5 shadow-xl">
          <div className="text-[11px] font-semibold text-ink">
            {selected ? KIND_LABEL[selected.kind] : 'New drawing defaults'}
          </div>
          <div>
            <div className="text-[10px] text-muted mb-1">Width</div>
            <div className="flex gap-1">
              {LINE_WIDTHS.map(w => (
                <button
                  key={w}
                  className={`flex-1 h-6 rounded border flex items-center justify-center ${
                    (selected?.width ?? width) === w ? 'border-accent bg-accent/15' : 'border-hairline hover:border-white/30'
                  }`}
                  onClick={() => { setWidth(w); patchSelected({ width: w }) }}
                >
                  <span className="block w-5 rounded-full bg-ink2" style={{ height: w }} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted mb-1">Style</div>
            <div className="flex gap-1">
              {LINE_STYLES.map(s => (
                <button
                  key={s}
                  className={`flex-1 text-[10px] py-1 rounded border capitalize ${
                    (selected?.style ?? style) === s ? 'border-accent bg-accent/15 text-ink' : 'border-hairline text-muted hover:border-white/30'
                  }`}
                  onClick={() => { setStyle(s); patchSelected({ style: s }) }}
                >{s}</button>
              ))}
            </div>
          </div>
          {selected && (selected.kind === 'rect' || selected.kind === 'fib') && (
            <div>
              <div className="text-[10px] text-muted mb-1">Fill {Math.round((selected.fillOpacity ?? 0.13) * 100)}%</div>
              <input
                type="range" min={0} max={60} step={1}
                value={Math.round((selected.fillOpacity ?? 0.13) * 100)}
                onChange={e => patchSelected({ fillOpacity: +e.target.value / 100 })}
                className="w-full accent-[#3987e5]"
              />
            </div>
          )}
          {selected && selected.kind === 'rect' && (
            <div className="flex gap-1">
              <button
                className={`flex-1 text-[10px] py-1 rounded border ${selected.extendLeft ? 'border-accent bg-accent/15 text-ink' : 'border-hairline text-muted'}`}
                onClick={() => patchSelected({ extendLeft: !selected.extendLeft })}
              >Extend ◀</button>
              <button
                className={`flex-1 text-[10px] py-1 rounded border ${selected.extendRight ? 'border-accent bg-accent/15 text-ink' : 'border-hairline text-muted'}`}
                onClick={() => patchSelected({ extendRight: !selected.extendRight })}
              >Extend ▶</button>
            </div>
          )}
          {selected && <TextAlignControls d={selected} onChange={patchSelected} />}
          <div className="text-[10px] text-muted leading-relaxed border-t border-hairline pt-2">
            Shift constrains a new line to 0° / 45° / 90°. Right-click a drawing for more.
          </div>
        </div>
      )}

      {menu && (() => {
        const d = engine.drawings.find(x => x.id === menu.id)
        if (!d) return null
        const item = 'w-full text-left px-2.5 py-1 text-[11px] text-ink2 hover:bg-white/10 rounded'
        return (
          <div
            ref={menuRef}
            className="absolute z-[7] w-40 bg-surface border border-white/10 rounded-lg p-1 shadow-xl"
            style={{ left: Math.min(menu.x, container.clientWidth - 170), top: Math.min(menu.y, container.clientHeight - 190) }}
          >
            <div className="px-2.5 py-1 text-[10px] text-muted">{KIND_LABEL[d.kind]}</div>
            <button className={item} onClick={() => { setShowSettings(true); setMenu(null) }}>Settings…</button>
            <button className={item} onClick={() => duplicateDrawing(d.id)}>Duplicate <span className="text-muted">Ctrl+D</span></button>
            <button className={item} onClick={() => reorder(d.id, true)}>Bring to front</button>
            <button className={item} onClick={() => reorder(d.id, false)}>Send to back</button>
            <button className={item} onClick={() => { commit(); d.locked = !d.locked; setMenu(null); setSelectedId(null); redraw() }}>
              {d.locked ? 'Unlock' : 'Lock'}
            </button>
            <div className="h-px bg-white/10 my-1" />
            <button className={`${item} hover:text-down`} onClick={() => removeDrawing(d.id)}>Delete <span className="text-muted">Del</span></button>
          </div>
        )
      })()}

      {editing && (
        <div className="absolute z-[6]" style={{ left: Math.min(editing.x, container.clientWidth - 190), top: Math.min(editing.y, container.clientHeight - 90) }}>
          <textarea
            ref={editorRef}
            autoFocus
            className="input !w-44 !py-1 text-xs min-h-[54px]"
            placeholder="Note… (Enter to save)"
            value={editing.value}
            onChange={e => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
            }}
            onBlur={commitText}
          />
        </div>
      )}
    </>
  )
}

/* ---------------- small pieces ---------------- */

function TextAlignControls({ d, onChange }: { d: Drawing; onChange: (p: Partial<Drawing>) => void }) {
  if (d.kind === 'text' || !d.text) return null
  const hs: TextH[] = ['left', 'center', 'right']
  const vs: TextV[] = ['top', 'middle', 'bottom']
  const cell = (on: boolean) =>
    `flex-1 text-[10px] py-1 rounded border capitalize ${on ? 'border-accent bg-accent/15 text-ink' : 'border-hairline text-muted hover:border-white/30'}`
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted">Label</div>
      <div className="flex gap-1">
        {hs.map(h => (
          <button key={h} className={cell((d.textH ?? 'left') === h)} onClick={() => onChange({ textH: h })}>{h}</button>
        ))}
      </div>
      <div className="flex gap-1">
        {vs.map(v => (
          <button key={v} className={cell((d.textV ?? 'top') === v)} onClick={() => onChange({ textV: v })}>{v}</button>
        ))}
      </div>
    </div>
  )
}

/** Selection handle: white core with the drawing's colour as the ring. */
function handleDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, active: boolean) {
  const r = active ? 5 : 4
  ctx.save()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = active ? color : '#ffffff'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = active ? '#ffffff' : color
  ctx.stroke()
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function placeLabel(ctx: CanvasRenderingContext2D, d: Drawing, g: Geom, paneW: number) {
  const lines = (d.text ?? '').split('\n').length
  ctx.save()
  ctx.setLineDash([])
  if (d.kind === 'hline') {
    const tx = d.textH === 'center' ? paneW / 2 : d.textH === 'right' ? paneW - 6 : 6
    const ty = d.textV === 'middle' ? g.ya - 6 : d.textV === 'bottom' ? g.ya + 4 : g.ya - 15
    ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
    drawText(ctx, d.text!, tx, ty)
  } else if (d.kind === 'rect' || d.kind === 'fib') {
    const rw = g.xRight - g.xLeft, rh = g.yBottom - g.yTop
    const tx = d.textH === 'center' ? g.xLeft + rw / 2 : d.textH === 'right' ? g.xLeft + rw - 5 : g.xLeft + 5
    const ty = d.textV === 'middle' ? g.yTop + rh / 2 - (lines * 14) / 2 + 2 : d.textV === 'bottom' ? g.yTop + rh - lines * 14 - 3 : g.yTop + 4
    ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
    drawText(ctx, d.text!, tx, ty, rw - 10)
  } else if (g.xb !== null && g.yb !== null) {
    const [sx, sy] = g.xa <= g.xb ? [g.xa, g.ya] : [g.xb, g.yb]
    const [ex, ey] = g.xa <= g.xb ? [g.xb, g.yb] : [g.xa, g.ya]
    const tx = d.textH === 'center' ? (sx + ex) / 2 : d.textH === 'right' ? ex : sx
    const anchorY = d.textH === 'center' ? (sy + ey) / 2 : d.textH === 'right' ? ey : sy
    const ty = d.textV === 'middle' ? anchorY - 6 : d.textV === 'bottom' ? anchorY + 8 : anchorY - 6 - lines * 14
    ctx.textAlign = d.textH === 'center' ? 'center' : d.textH === 'right' ? 'right' : 'left'
    drawText(ctx, d.text!, tx, ty)
  } else {
    ctx.restore()
    return
  }
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const t = maxWidth !== undefined ? clip(ctx, line, maxWidth) : line
    ctx.fillText(t, x, y + i * 14)
  })
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
  return s + '…'
}
