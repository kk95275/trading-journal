// Renders the Sessions indicator under the drawing layer: either background shading
// (Pine bgcolor mode) or running session high/low bands (Pine "High/Low View").
import { useCallback, useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts'
import type { Bar } from '../lib/types'
import type { ReplayEngine } from '../replay/engine'
import { inSession, type SessionDef, type SessionsConfig } from '../replay/sessions'

interface Props {
  container: HTMLElement
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  engine: ReplayEngine
  getBars: () => Bar[]
  dataVersion: number
  config: SessionsConfig
  onCanvas: (c: HTMLCanvasElement | null) => void
}

const RUN_GAP_SEC = 4 * 3600 // a time gap larger than this breaks a session run (weekend)

interface Run { from: number; to: number } // bar indices, inclusive

function findRuns(bars: Bar[], s: SessionDef, fromIdx: number, toIdx: number): Run[] {
  // extend left so a run that started before the visible window is complete (H/L needs it)
  let start = fromIdx
  while (start > 0 && inSession(bars[start].time, s) && inSession(bars[start - 1].time, s) &&
         bars[start].time - bars[start - 1].time < RUN_GAP_SEC && fromIdx - start < 2000) start--
  const runs: Run[] = []
  let cur: Run | null = null
  for (let i = start; i <= toIdx; i++) {
    if (inSession(bars[i].time, s)) {
      if (cur && (bars[i].time - bars[i - 1].time >= RUN_GAP_SEC || !inSession(bars[i - 1].time, s))) {
        runs.push(cur)
        cur = null
      }
      if (!cur) cur = { from: i, to: i }
      else cur.to = i
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  return runs
}

export default function SessionsLayer({ container, chart, series, engine, getBars, dataVersion, config, onCanvas }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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
    if (!config.enabled) return
    const bars = getBars()
    if (!bars.length) return
    const ts = chart.timeScale()
    const vr = ts.getVisibleLogicalRange()
    if (!vr) return
    const paneW = ts.width(), paneH = h - ts.height()
    const fromIdx = Math.max(0, Math.floor(vr.from))
    const toIdx = Math.min(bars.length - 1, Math.ceil(vr.to))
    if (toIdx < fromIdx) return
    const barSpacing = (vr.to > vr.from) ? paneW / (vr.to - vr.from) : 8
    const xOf = (i: number): number => {
      const x = ts.logicalToCoordinate(i as Logical)
      return x !== null ? x : ((i - vr.from) / (vr.to - vr.from)) * paneW
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, paneW, paneH)
    ctx.clip()
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'top'

    for (const s of config.sessions) {
      if (!s.enabled) continue
      const runs = findRuns(bars, s, fromIdx, toIdx)
      for (const run of runs) {
        const x1 = xOf(run.from) - barSpacing / 2
        const x2 = xOf(run.to) + barSpacing / 2
        if (x2 < 0 || x1 > paneW) continue
        if (config.mode === 'bg') {
          ctx.globalAlpha = 0.09
          ctx.fillStyle = s.color
          ctx.fillRect(x1, 0, x2 - x1, paneH)
          ctx.globalAlpha = 0.9
          ctx.fillText(s.name, Math.max(x1 + 3, 34), 3)
          ctx.globalAlpha = 1
        } else {
          // running high/low band across the session
          let hi = -Infinity, lo = Infinity
          const top: [number, number][] = []
          const bot: [number, number][] = []
          for (let i = run.from; i <= run.to; i++) {
            if (bars[i].high > hi) hi = bars[i].high
            if (bars[i].low < lo) lo = bars[i].low
            const yH = series.priceToCoordinate(hi)
            const yL = series.priceToCoordinate(lo)
            if (yH === null || yL === null) continue
            const x = xOf(i)
            top.push([x, yH])
            bot.push([x, yL])
          }
          if (top.length < 2) continue
          ctx.beginPath()
          ctx.moveTo(top[0][0], top[0][1])
          for (const [x, y] of top) ctx.lineTo(x, y)
          for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1])
          ctx.closePath()
          ctx.globalAlpha = 0.13
          ctx.fillStyle = s.color
          ctx.fill()
          ctx.globalAlpha = 0.7
          ctx.strokeStyle = s.color
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.globalAlpha = 0.95
          ctx.fillText(s.name, Math.max(top[0][0] + 3, 34), Math.max(2, top[top.length - 1][1] - 13))
          ctx.globalAlpha = 1
        }
      }
    }
    ctx.restore()
  }, [chart, container, series, getBars, config])

  useEffect(() => {
    const ts = chart.timeScale()
    const onRange = () => redraw()
    ts.subscribeVisibleLogicalRangeChange(onRange)
    const unsub = engine.subscribe(redraw)
    const ro = new ResizeObserver(redraw)
    ro.observe(container)
    redraw()
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRange)
      unsub()
      ro.disconnect()
    }
  }, [chart, container, engine, redraw])

  // See DrawingLayer.tsx's identical effect: lightweight-charts' price scale has no
  // change-subscription API, so a price-axis drag never fires a redraw on its own.
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

  useEffect(() => { redraw() }, [dataVersion, config, redraw])
  useEffect(() => { onCanvas(canvasRef.current); return () => onCanvas(null) }, [onCanvas])

  return <canvas ref={canvasRef} className="absolute inset-0 z-[2] pointer-events-none" style={{ width: '100%', height: '100%' }} />
}
