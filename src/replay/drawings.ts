// Chart drawings (trendlines, rectangles, horizontal lines, text notes).
// Anchors are stored in (time, price) space so drawings stick to the candles
// across pan/zoom and timeframe switches.
import type { Bar } from '../lib/types'

export type DrawKind = 'trend' | 'rect' | 'hline' | 'text'
export type Tool = 'cursor' | DrawKind

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
  b?: Anchor // trend & rect
  color: string
  text?: string
  textH?: TextH // rect: inside · hline/trend: along the line (default left)
  textV?: TextV // rect: inside · hline/trend: above/on/below (default top)
}

export const DRAW_COLORS = ['#3987e5', '#eb6834', '#0ca30c', '#d03b3b', '#9085e9', '#e8e6df']

let seq = 1
export const nextDrawingId = () => seq++

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
