// Chart drawings. Anchors are stored in (time, price) space so drawings stick to
// the candles across pan/zoom and timeframe switches.
//
// Geometry lives here rather than in the component: resolving a drawing to pixels
// and working out where its handles sit is needed by the renderer, the hit test
// and the drag logic alike, and those three disagreeing is what makes a drawing
// layer feel broken.
import type { Bar } from '../lib/types'

export type DrawKind = 'trend' | 'ray' | 'extended' | 'rect' | 'hline' | 'vline' | 'fib' | 'text'
export type Tool = 'cursor' | DrawKind

export type LineStyle = 'solid' | 'dashed' | 'dotted'

export interface Anchor {
  time: number
  price: number
}

export type TextH = 'left' | 'center' | 'right'
export type TextV = 'top' | 'middle' | 'bottom'

export interface Drawing {
  id: number
  kind: DrawKind
  a: Anchor
  b?: Anchor // every kind but hline / vline / text
  color: string
  width?: number        // stroke width in px — 1 is the default
  style?: LineStyle     // solid is the default
  fillOpacity?: number  // rect and fib shading — 0.13 is the default
  locked?: boolean      // ignored by the hit test, so it can't be grabbed
  text?: string
  textH?: TextH // rect: inside · hline/trend: along the line (default left)
  textV?: TextV // rect: inside · hline/trend: above/on/below (default top)
  extendLeft?: boolean  // rect only — draws left edge at pane x=0 regardless of anchor time
  extendRight?: boolean // rect only — draws right edge at pane width; useful for "zone continues"
}

export const DRAW_COLORS = ['#3987e5', '#eb6834', '#0ca30c', '#d03b3b', '#9085e9', '#e8e6df']

export const LINE_WIDTHS = [1, 2, 3, 4]
export const LINE_STYLES: LineStyle[] = ['solid', 'dashed', 'dotted']

/** Retracement levels, drawn between the two anchors. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

/** Kinds that need a second click to place their b anchor. */
export const TWO_POINT: DrawKind[] = ['trend', 'ray', 'extended', 'rect', 'fib']

export const KIND_LABEL: Record<DrawKind, string> = {
  trend: 'Trendline',
  ray: 'Ray',
  extended: 'Extended line',
  rect: 'Rectangle',
  hline: 'Horizontal line',
  vline: 'Vertical line',
  fib: 'Fib retracement',
  text: 'Text',
}

let seq = 1
export const nextDrawingId = () => seq++
/** Keeps ids unique after drawings are restored from elsewhere (pop-out windows). */
export const bumpDrawingSeq = (used: number) => { if (used >= seq) seq = used + 1 }

export function dashFor(style: LineStyle | undefined, width: number): number[] {
  if (style === 'dashed') return [width * 4, width * 3]
  if (style === 'dotted') return [1, width * 2.5]
  return []
}

/* ---------------- handles ---------------- */

/**
 * `mid` drags the whole thing; the compass parts resize one edge or corner.
 * A rectangle gets all eight, so its sides can be moved independently — the
 * midpoints on the left and right move that vertical edge, and the midpoints
 * on the top and bottom move that horizontal edge.
 */
export type HandlePart =
  | 'a' | 'b' | 'mid'
  | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type HitPart = HandlePart | 'body'

export interface HandlePoint {
  part: HandlePart
  x: number
  y: number
}

export const HANDLE_CURSOR: Record<HandlePart, string> = {
  a: 'pointer', b: 'pointer', mid: 'move',
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
}

/** A drawing resolved to pixels. Null coordinates mean it isn't on screen. */
export interface Geom {
  xa: number
  ya: number
  xb: number | null
  yb: number | null
  /** Rect/fib bounds, after extend flags. */
  xLeft: number
  xRight: number
  yTop: number
  yBottom: number
  paneW: number
  paneH: number
}

export function geomOf(
  d: Drawing,
  xa: number, ya: number,
  xb: number | null, yb: number | null,
  paneW: number, paneH: number,
): Geom {
  const hasB = xb !== null && yb !== null
  const anchorLeft = hasB ? Math.min(xa, xb!) : xa
  const anchorRight = hasB ? Math.max(xa, xb!) : xa
  return {
    xa, ya, xb, yb,
    xLeft: d.extendLeft ? 0 : anchorLeft,
    xRight: d.extendRight ? paneW : anchorRight,
    yTop: hasB ? Math.min(ya, yb!) : ya,
    yBottom: hasB ? Math.max(ya, yb!) : ya,
    paneW, paneH,
  }
}

/** Where a selected drawing's grab handles sit, in pixels. */
export function handlesFor(d: Drawing, g: Geom): HandlePoint[] {
  switch (d.kind) {
    case 'rect': {
      if (g.xb === null || g.yb === null) return []
      const { xLeft: l, xRight: r, yTop: t, yBottom: b } = g
      const cx = (l + r) / 2, cy = (t + b) / 2
      return [
        { part: 'nw', x: l, y: t }, { part: 'n', x: cx, y: t }, { part: 'ne', x: r, y: t },
        { part: 'w', x: l, y: cy }, { part: 'e', x: r, y: cy },
        { part: 'sw', x: l, y: b }, { part: 's', x: cx, y: b }, { part: 'se', x: r, y: b },
      ]
    }
    case 'fib': {
      if (g.xb === null || g.yb === null) return []
      const cx = (g.xa + g.xb) / 2, cy = (g.ya + g.yb) / 2
      return [
        { part: 'a', x: g.xa, y: g.ya },
        { part: 'mid', x: cx, y: cy },
        { part: 'b', x: g.xb, y: g.yb },
      ]
    }
    case 'trend': case 'ray': case 'extended': {
      if (g.xb === null || g.yb === null) return []
      const cx = (g.xa + g.xb) / 2, cy = (g.ya + g.yb) / 2
      return [
        { part: 'a', x: g.xa, y: g.ya },
        { part: 'mid', x: cx, y: cy },
        { part: 'b', x: g.xb, y: g.yb },
      ]
    }
    case 'hline':
      // Three along the line: the outer two read as grab points, the middle moves it.
      return [
        { part: 'a', x: g.paneW * 0.25, y: g.ya },
        { part: 'mid', x: g.paneW * 0.5, y: g.ya },
        { part: 'b', x: g.paneW * 0.75, y: g.ya },
      ]
    case 'vline':
      return [
        { part: 'a', x: g.xa, y: g.paneH * 0.25 },
        { part: 'mid', x: g.xa, y: g.paneH * 0.5 },
        { part: 'b', x: g.xa, y: g.paneH * 0.75 },
      ]
    default:
      return [{ part: 'mid', x: g.xa, y: g.ya }]
  }
}

/* ---------------- editing helpers ---------------- */

/**
 * Apply a compass-handle drag to a two-anchor drawing. Whichever anchor is
 * currently on the dragged side is the one that moves, so a rectangle can be
 * flipped through itself without the handles swapping meaning mid-drag.
 */
export function resizeByPart(d: Drawing, part: HandlePart, at: Anchor): void {
  if (!d.b) return
  const earlier = d.a.time <= d.b.time ? 'a' : 'b'
  const later = earlier === 'a' ? 'b' : 'a'
  const higher = d.a.price >= d.b.price ? 'a' : 'b'
  const lower = higher === 'a' ? 'b' : 'a'
  const setTime = (k: 'a' | 'b', time: number) => { d[k] = { ...d[k]!, time } }
  const setPrice = (k: 'a' | 'b', price: number) => { d[k] = { ...d[k]!, price } }

  switch (part) {
    case 'w': setTime(earlier, at.time); d.extendLeft = false; break
    case 'e': setTime(later, at.time); d.extendRight = false; break
    case 'n': setPrice(higher, at.price); break
    case 's': setPrice(lower, at.price); break
    case 'nw': setTime(earlier, at.time); setPrice(higher, at.price); d.extendLeft = false; break
    case 'ne': setTime(later, at.time); setPrice(higher, at.price); d.extendRight = false; break
    case 'sw': setTime(earlier, at.time); setPrice(lower, at.price); d.extendLeft = false; break
    case 'se': setTime(later, at.time); setPrice(lower, at.price); d.extendRight = false; break
    case 'a': d.a = at; break
    case 'b': d.b = at; break
    default: break
  }
}

/** Shift-drag: snap the free end to horizontal, vertical or 45°. */
export function constrain(ax: number, ay: number, bx: number, by: number): { x: number; y: number } {
  const dx = bx - ax, dy = by - ay
  const adx = Math.abs(dx), ady = Math.abs(dy)
  if (adx < 1 && ady < 1) return { x: bx, y: by }
  const ratio = ady / (adx || 0.0001)
  if (ratio < 0.4142) return { x: bx, y: ay }                    // < 22.5° → horizontal
  if (ratio > 2.4142) return { x: ax, y: by }                    // > 67.5° → vertical
  const m = Math.min(adx, ady)                                   // else 45°
  return { x: ax + Math.sign(dx) * m, y: ay + Math.sign(dy) * m }
}

/** Index of the bar whose time is closest to `time` (bars sorted ascending). */
export function nearestIndex(bars: Bar[], time: number): number {
  const n = bars.length
  if (!n) return 0
  if (time <= bars[0].time) return 0
  if (time >= bars[n - 1].time) return n - 1
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time < time) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && time - bars[lo - 1].time < bars[lo].time - time ? lo - 1 : lo
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx, cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * Where a ray or extended line leaves the pane. Returns the segment to stroke,
 * clipped to the pane so the canvas never strokes a line thousands of px long.
 */
export function extendSegment(
  kind: DrawKind, xa: number, ya: number, xb: number, yb: number, paneW: number, paneH: number,
): [number, number, number, number] {
  if (kind === 'trend') return [xa, ya, xb, yb]
  const dx = xb - xa, dy = yb - ya
  if (!dx && !dy) return [xa, ya, xb, yb]
  // Parametric: p = a + t*(b-a). Find t at the pane edges.
  const tAt = (far: boolean): number => {
    const cand: number[] = []
    if (dx) { cand.push((0 - xa) / dx, (paneW - xa) / dx) }
    if (dy) { cand.push((0 - ya) / dy, (paneH - ya) / dy) }
    const want = far ? cand.filter(t => t > 1) : cand.filter(t => t < 0)
    if (!want.length) return far ? 1 : 0
    return far ? Math.min(...want) : Math.max(...want)
  }
  const tFar = tAt(true)
  const tNear = kind === 'extended' ? tAt(false) : 0
  return [xa + dx * tNear, ya + dy * tNear, xa + dx * tFar, ya + dy * tFar]
}

/** Deep-enough copy for the undo stack — anchors are the only nested objects. */
export function cloneDrawings(ds: Drawing[]): Drawing[] {
  return ds.map(d => ({ ...d, a: { ...d.a }, b: d.b ? { ...d.b } : undefined }))
}
