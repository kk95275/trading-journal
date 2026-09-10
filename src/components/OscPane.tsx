// Oscillator pane (RSI / MACD): a small chart below the main chart with a two-way
// synced time scale. Warmup bars are whitespace points so both charts always hold
// the same number of logical points, keeping x-coordinates aligned; price scales
// are width-locked with minimumWidth for pixel-exact alignment.
import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import type { Bar } from '../lib/types'
import type { IReplayView } from '../replay/engine'
import {
  macdFull, macdLast, rsiFull, rsiLast, HIST_UP, HIST_DOWN,
  type ActiveIndicator, type MacdResult, type RsiResult,
} from '../replay/indicators'
import { indicatorLabel } from '../replay/indicators'

interface Props {
  mainChart: IChartApi
  engine: IReplayView
  getBars: () => Bar[]
  dataVersion: number
  ind: ActiveIndicator
}

const PRICE_SCALE_MIN_WIDTH = 64

export default function OscPane({ mainChart, engine, getBars, dataVersion, ind }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdSeriesRef = useRef<{ macd: ISeriesApi<'Line'>; signal: ISeriesApi<'Line'>; hist: ISeriesApi<'Histogram'> } | null>(null)
  const rsiStateRef = useRef<RsiResult | null>(null)
  const macdStateRef = useRef<MacdResult | null>(null)

  // create the pane chart + two-way time sync
  useEffect(() => {
    const el = containerRef.current!
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: '#131312' }, textColor: '#898781', fontSize: 10 },
      grid: { vertLines: { color: '#242423' }, horzLines: { color: '#242423' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#383835', minimumWidth: PRICE_SCALE_MIN_WIDTH },
      timeScale: { borderColor: '#383835', visible: false },
      handleScroll: true,
      handleScale: true,
    })
    chartRef.current = chart
    mainChart.applyOptions({ rightPriceScale: { minimumWidth: PRICE_SCALE_MIN_WIDTH } })

    let guard = false
    const syncFrom = (src: IChartApi, dst: IChartApi) => () => {
      if (guard) return
      const r = src.timeScale().getVisibleLogicalRange()
      if (!r) return
      guard = true
      dst.timeScale().setVisibleLogicalRange(r)
      guard = false
    }
    const fromMain = syncFrom(mainChart, chart)
    const fromOsc = syncFrom(chart, mainChart)
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(fromMain)
    chart.timeScale().subscribeVisibleLogicalRangeChange(fromOsc)
    fromMain()

    return () => {
      try { mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(fromMain) } catch { /* disposed */ }
      chart.remove()
      chartRef.current = null
      rsiSeriesRef.current = null
      macdSeriesRef.current = null
    }
  }, [mainChart])

  // (re)build series on config/data changes, incremental update on engine ticks
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const buildFull = () => {
      const bars = getBars()
      if (ind.kind === 'rsi') {
        const L = ind.length ?? 14
        if (!rsiSeriesRef.current) {
          const s = chart.addLineSeries({ color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true })
          s.createPriceLine({ price: 70, color: '#898781', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
          s.createPriceLine({ price: 30, color: '#898781', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
          rsiSeriesRef.current = s
        }
        rsiSeriesRef.current.applyOptions({ color: ind.color })
        const r = rsiFull(bars, L)
        rsiStateRef.current = r
        rsiSeriesRef.current.setData(r.data)
      } else {
        const F = ind.fast ?? 12, S = ind.slow ?? 26, G = ind.signal ?? 9
        if (!macdSeriesRef.current) {
          macdSeriesRef.current = {
            hist: chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
            macd: chart.addLineSeries({ color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
            signal: chart.addLineSeries({ color: '#eda100', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
          }
        }
        macdSeriesRef.current.macd.applyOptions({ color: ind.color })
        const r = macdFull(bars, F, S, G)
        macdStateRef.current = r
        macdSeriesRef.current.macd.setData(r.macd)
        macdSeriesRef.current.signal.setData(r.signal)
        macdSeriesRef.current.hist.setData(r.hist)
      }
    }

    const updateTick = () => {
      const bars = getBars()
      const i = bars.length - 1
      if (i < 0) return
      const t = bars[i].time as UTCTimestamp
      if (ind.kind === 'rsi') {
        const st = rsiStateRef.current
        if (!st) return buildFull()
        const v = rsiLast(bars, ind.length ?? 14, st)
        if (v === null) return buildFull()
        rsiSeriesRef.current?.update({ time: t, value: v })
      } else {
        const st = macdStateRef.current
        if (!st) return buildFull()
        const v = macdLast(bars, ind.fast ?? 12, ind.slow ?? 26, ind.signal ?? 9, st)
        if (v === null) return buildFull()
        macdSeriesRef.current?.macd.update({ time: t, value: v.macd })
        macdSeriesRef.current?.signal.update({ time: t, value: v.signal })
        macdSeriesRef.current?.hist.update({ time: t, value: v.hist, color: v.hist >= 0 ? HIST_UP : HIST_DOWN })
      }
    }

    buildFull()
    const unsub = engine.subscribe(updateTick)
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, dataVersion, ind, ind.length, ind.fast, ind.slow, ind.signal, ind.color])

  return (
    <div className="relative h-28 shrink-0 border-t border-hairline">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="absolute left-1.5 top-1 z-[3] text-[10px] text-muted pointer-events-none">{indicatorLabel(ind)}</div>
    </div>
  )
}
