import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  createChart, CrosshairMode, LineStyle,
  type CandlestickData, type HistogramData, type IChartApi, type IPriceLine,
  type ISeriesApi, type SeriesMarker, type UTCTimestamp,
} from 'lightweight-charts'
import type { Bar } from '../lib/types'
import { specFor } from '../lib/symbols'
import * as data from '../data/dataService'
import type { IReplayView } from '../replay/engine'
import type { SessionsConfig } from '../replay/sessions'
import { isOscillator, OverlayManager, type IndicatorsConfig } from '../replay/indicators'
import DrawingLayer from './DrawingLayer'
import SessionsLayer from './SessionsLayer'
import OscPane from './OscPane'

export interface ChartHandle {
  screenshot: () => Promise<Blob | null>
}

interface Props {
  engine: IReplayView
  tfSec: number
  sessions?: SessionsConfig
  indicators?: IndicatorsConfig
  onStopsDragged: (posId: number, sl: number | undefined, tp: number | undefined) => void
}

const UP = '#0ca30c'
const DOWN = '#d03b3b'

function toCandle(b: Bar): CandlestickData<UTCTimestamp> {
  return { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close }
}

function toVol(b: Bar): HistogramData<UTCTimestamp> {
  return { time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? 'rgba(12,163,12,0.35)' : 'rgba(208,59,59,0.35)' }
}

const ReplayChart = forwardRef<ChartHandle, Props>(function ReplayChart({ engine, tfSec, sessions, indicators, onStopsDragged }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const aggRef = useRef<Bar[]>([])
  const lastIdxRef = useRef(-1)
  const gapMarkersRef = useRef<SeriesMarker<UTCTimestamp>[]>([])
  const allLinesRef = useRef<IPriceLine[]>([])
  const dragLinesRef = useRef<{ posId: number; which: 'sl' | 'tp'; line: IPriceLine }[]>([])
  const dragRef = useRef<{ posId: number; which: 'sl' | 'tp'; price: number } | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const sessionsCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayMgrRef = useRef<OverlayManager | null>(null)
  const [ready, setReady] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)

  useImperativeHandle(ref, () => ({
    screenshot: () =>
      new Promise<Blob | null>(resolve => {
        const chart = chartRef.current
        if (!chart) return resolve(null)
        requestAnimationFrame(() => {
          try {
            const shot = chart.takeScreenshot()
            const layers = [sessionsCanvasRef.current, overlayRef.current].filter((c): c is HTMLCanvasElement => !!c && c.width > 0)
            if (layers.length) {
              const merged = document.createElement('canvas')
              merged.width = shot.width
              merged.height = shot.height
              const ctx = merged.getContext('2d')!
              ctx.drawImage(shot, 0, 0)
              for (const layer of layers) ctx.drawImage(layer, 0, 0, shot.width, shot.height)
              merged.toBlob(b => resolve(b), 'image/png')
            } else {
              shot.toBlob(b => resolve(b), 'image/png')
            }
          } catch {
            resolve(null)
          }
        })
      }),
  }))

  // create chart once (ReplayChart remounts per session, so the symbol is fixed here)
  useEffect(() => {
    const el = containerRef.current!
    const decimals = specFor(engine.config.symbol).decimals
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: '#131312' }, textColor: '#898781', fontSize: 11 },
      grid: { vertLines: { color: '#242423' }, horzLines: { color: '#242423' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#383835' },
      timeScale: { borderColor: '#383835', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8 },
      localization: { priceFormatter: (p: number) => p.toFixed(decimals) },
    })
    const candle = chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals },
    })
    const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    chartRef.current = chart
    candleRef.current = candle
    volRef.current = vol
    overlayMgrRef.current = new OverlayManager(chart)
    setReady(true)
    return () => {
      setReady(false)
      overlayMgrRef.current = null
      chart.remove()
      chartRef.current = null
    }
  }, [])

  // indicator overlays: full re-sync on config / data changes
  useEffect(() => {
    if (indicators) overlayMgrRef.current?.sync(indicators, aggRef.current)
  }, [indicators, dataVersion])

  // volume visibility
  useEffect(() => {
    volRef.current?.applyOptions({ visible: indicators?.showVolume ?? true })
  }, [indicators?.showVolume, ready])

  // drag SL/TP price lines
  useEffect(() => {
    const el = containerRef.current!
    const yOf = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top

    const nearLine = (y: number): { posId: number; which: 'sl' | 'tp' } | null => {
      const candle = candleRef.current
      if (!candle) return null
      for (const pos of engine.positions) {
        for (const which of ['sl', 'tp'] as const) {
          const price = pos[which]
          if (price === undefined) continue
          const ly = candle.priceToCoordinate(price)
          if (ly !== null && Math.abs(ly - y) < 7) return { posId: pos.id, which }
        }
      }
      return null
    }

    const onDown = (e: PointerEvent) => {
      const hit = nearLine(yOf(e))
      if (!hit) return
      const pos = engine.positions.find(p => p.id === hit.posId)
      if (!pos) return
      dragRef.current = { posId: hit.posId, which: hit.which, price: pos[hit.which]! }
      chartRef.current?.applyOptions({ handleScroll: false, handleScale: false })
      el.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) {
        el.style.cursor = nearLine(yOf(e)) ? 'ns-resize' : ''
        return
      }
      const price = candleRef.current?.coordinateToPrice(yOf(e))
      if (price == null) return
      drag.price = +(+price).toFixed(specFor(engine.config.symbol).decimals)
      dragLinesRef.current.find(l => l.posId === drag.posId && l.which === drag.which)?.line.applyOptions({ price: drag.price })
    }
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      chartRef.current?.applyOptions({ handleScroll: true, handleScale: true })
      el.releasePointerCapture(e.pointerId)
      const pos = engine.positions.find(p => p.id === drag.posId)
      if (pos) {
        const sl = drag.which === 'sl' ? drag.price : pos.sl
        const tp = drag.which === 'tp' ? drag.price : pos.tp
        onStopsDragged(drag.posId, sl, tp)
      }
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
  }, [engine, onStopsDragged])

  // data: full rebuild on tf/engine change, incremental on engine advance
  useEffect(() => {
    let cancelled = false

    const refreshMarkers = () => {
      const candle = candleRef.current
      if (!candle) return
      const markers: SeriesMarker<UTCTimestamp>[] = [...gapMarkersRef.current]
      for (const t of engine.sessionTrades) {
        const eb = (Math.floor(t.entryTime / tfSec) * tfSec) as UTCTimestamp
        const xb = (Math.floor(t.exitTime / tfSec) * tfSec) as UTCTimestamp
        markers.push({
          time: eb, position: t.direction === 'long' ? 'belowBar' : 'aboveBar',
          color: t.direction === 'long' ? UP : DOWN, shape: t.direction === 'long' ? 'arrowUp' : 'arrowDown', text: '',
        })
        markers.push({ time: xb, position: 'aboveBar', color: t.pnl >= 0 ? UP : DOWN, shape: 'circle', text: '' })
      }
      for (const pos of engine.positions) {
        markers.push({
          time: (Math.floor(pos.entryTime / tfSec) * tfSec) as UTCTimestamp,
          position: pos.direction === 'long' ? 'belowBar' : 'aboveBar',
          color: pos.direction === 'long' ? UP : DOWN, shape: pos.direction === 'long' ? 'arrowUp' : 'arrowDown', text: '',
        })
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number))
      candle.setMarkers(markers.slice(-180))
    }

    const refreshLines = () => {
      const candle = candleRef.current
      if (!candle) return
      if (dragRef.current) return // don't rebuild lines mid-drag
      for (const l of allLinesRef.current) candle.removePriceLine(l)
      allLinesRef.current = []
      dragLinesRef.current = []
      const many = engine.positions.length > 1
      for (const pos of engine.positions) {
        const tag = many ? ` #${pos.id}` : ''
        const entry = candle.createPriceLine({
          price: pos.entryPrice, color: '#3987e5', lineWidth: 1, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: `${pos.direction.toUpperCase()} ${pos.lots}${tag}`,
        })
        allLinesRef.current.push(entry)
        if (pos.sl !== undefined) {
          const sl = candle.createPriceLine({
            price: pos.sl, color: DOWN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `SL${tag} (drag)`,
          })
          allLinesRef.current.push(sl)
          dragLinesRef.current.push({ posId: pos.id, which: 'sl', line: sl })
        }
        if (pos.tp !== undefined) {
          const tp = candle.createPriceLine({
            price: pos.tp, color: UP, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `TP${tag} (drag)`,
          })
          allLinesRef.current.push(tp)
          dragLinesRef.current.push({ posId: pos.id, which: 'tp', line: tp })
        }
      }
    }

    const mergeBar = (b: Bar) => {
      const agg = aggRef.current
      const bucket = Math.floor(b.time / tfSec) * tfSec
      const last = agg[agg.length - 1]
      if (last && last.time === bucket) {
        if (b.high > last.high) last.high = b.high
        if (b.low < last.low) last.low = b.low
        last.close = b.close
        last.volume += b.volume
        candleRef.current?.update(toCandle(last))
        volRef.current?.update(toVol(last))
      } else {
        if (last && bucket - last.time > Math.max(6 * 3600, tfSec * 3)) {
          gapMarkersRef.current.push({
            time: bucket as UTCTimestamp, position: 'aboveBar', color: '#898781', shape: 'circle', text: 'closed',
          })
          gapMarkersRef.current = gapMarkersRef.current.slice(-40)
        }
        const nb: Bar = { ...b, time: bucket }
        agg.push(nb)
        candleRef.current?.update(toCandle(nb))
        volRef.current?.update(toVol(nb))
      }
    }

    const rebuild = async () => {
      const first = engine.oneMin[0]
      if (!first) return
      const bucketFirst = Math.floor(first.time / tfSec) * tfSec
      const ctx = await data.getContextBars(engine.config.symbol, tfSec, bucketFirst, 350)
      if (cancelled) return
      const agg = data.aggregate(engine.oneMin.slice(0, engine.idx + 1), tfSec)
      aggRef.current = [...ctx.filter(b => b.time < bucketFirst), ...agg]
      gapMarkersRef.current = []
      candleRef.current?.setData(aggRef.current.map(toCandle))
      volRef.current?.setData(aggRef.current.map(toVol))
      lastIdxRef.current = engine.idx
      refreshLines()
      refreshMarkers()
      chartRef.current?.timeScale().scrollToRealTime()
      setDataVersion(v => v + 1)
    }

    const onEngineChange = () => {
      if (cancelled) return
      if (engine.idx < lastIdxRef.current) { void rebuild(); return }
      const advanced = engine.idx > lastIdxRef.current
      for (let i = lastIdxRef.current + 1; i <= engine.idx; i++) mergeBar(engine.oneMin[i])
      lastIdxRef.current = engine.idx
      if (advanced) overlayMgrRef.current?.updateLast(aggRef.current)
      refreshLines()
      refreshMarkers()
    }

    void rebuild()
    const unsub = engine.subscribe(onEngineChange)
    return () => { cancelled = true; unsub() }
  }, [engine, tfSec])

  const getBars = useCallback(() => aggRef.current, [])
  const onCanvas = useCallback((c: HTMLCanvasElement | null) => { overlayRef.current = c }, [])
  const onSessionsCanvas = useCallback((c: HTMLCanvasElement | null) => { sessionsCanvasRef.current = c }, [])
  const oscillators = indicators?.active.filter(a => isOscillator(a.kind)) ?? []

  return (
    <div className="w-full h-full min-h-[420px] flex flex-col">
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {ready && chartRef.current && candleRef.current && containerRef.current && (
          <>
            {sessions && (
              <SessionsLayer
                container={containerRef.current}
                chart={chartRef.current}
                series={candleRef.current}
                engine={engine}
                getBars={getBars}
                dataVersion={dataVersion}
                config={sessions}
                onCanvas={onSessionsCanvas}
              />
            )}
            <DrawingLayer
              container={containerRef.current}
              chart={chartRef.current}
              series={candleRef.current}
              engine={engine}
              getBars={getBars}
              dataVersion={dataVersion}
              onCanvas={onCanvas}
            />
          </>
        )}
      </div>
      {ready && chartRef.current && oscillators.map(o => (
        <OscPane
          key={o.id}
          mainChart={chartRef.current!}
          engine={engine}
          getBars={getBars}
          dataVersion={dataVersion}
          ind={o}
        />
      ))}
    </div>
  )
})

export default ReplayChart
