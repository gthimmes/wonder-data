import { useEffect, useRef, useState } from 'react'
import embed, { type VisualizationSpec } from 'vega-embed'
import type { ColumnMeta } from '../core/compiler'
import { formatDate } from '../core/format'
import type { ChartType } from './chartType'

/**
 * Validated categorical palette (fixed slot order; see docs/dataviz notes).
 * Hues are assigned by position and never cycled past the eighth series.
 */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const TEXT_SECONDARY = '#52514e'
const GRID = '#ebebe9'
const MAX_CATEGORIES = 8
const HORIZONTAL_AT = 12

interface Props {
  type: Exclude<ChartType, 'table'>
  columns: ColumnMeta[]
  rows: Record<string, unknown>[]
}

function vegaFormat(col: ColumnMeta): string {
  switch (col.format) {
    case 'currency':
      return '$,.0f'
    case 'percent':
      return '.1%'
    case 'integer':
      return ',d'
    case 'hours':
      return ',.1f'
    default:
      return ',.2f'
  }
}

function timeUnit(grain?: ColumnMeta['grain']): string | undefined {
  switch (grain) {
    case 'year':
      return 'year'
    case 'quarter':
      return 'yearquarter'
    case 'month':
      return 'yearmonth'
    default:
      return undefined
  }
}

function label(v: unknown, col: ColumnMeta): string {
  if (v == null) return '(blank)'
  if (col.type === 'date') return formatDate(String(v), col.grain)
  if (col.type === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

/**
 * Build a Vega-Lite spec from the result shape. Rules:
 *  - the x axis is the date dimension when there is one, else the first dimension
 *  - a second dimension becomes the series (color), capped to 8, never cycled
 *  - several measures become one small-multiple panel per measure, never a dual axis
 *  - many categories on a bar chart flip to horizontal so labels stay readable
 */
export function buildSpec(type: Props['type'], columns: ColumnMeta[], rows: Record<string, unknown>[], width: number): VisualizationSpec {
  const dims = columns.filter((c) => c.kind === 'dimension')
  const measures = columns.filter((c) => c.kind !== 'dimension')
  const dateDim = dims.find((d) => d.type === 'date')
  const x = type === 'pie' ? dims[0] : (dateDim ?? dims[0])
  const series = dims.find((d) => d !== x)

  // Fold rows so each measure becomes its own panel: {x, series, measure, value}
  const data: Record<string, unknown>[] = []
  const seriesSeen: string[] = []
  const xSeen: string[] = []
  for (const r of rows) {
    const s = series ? label(r[series.key], series) : undefined
    if (s !== undefined && !seriesSeen.includes(s)) {
      if (seriesSeen.length >= MAX_CATEGORIES) continue
      seriesSeen.push(s)
    }
    const xl = x ? label(r[x.key], x) : 'Total'
    if (!xSeen.includes(xl)) xSeen.push(xl)
    for (const m of measures) {
      data.push({
        x: x && x.type === 'date' ? r[x.key] : xl,
        xLabel: xl,
        series: s,
        measure: m.label,
        value: r[m.key] == null ? null : Number(r[m.key]),
      })
    }
  }
  if (series?.type === 'date') seriesSeen.sort()

  const isTemporal = x?.type === 'date'
  const horizontal = type === 'bar' && !isTemporal && xSeen.length > HORIZONTAL_AT
  const axisText = { labelColor: TEXT_SECONDARY, titleColor: TEXT_SECONDARY }
  const xEnc: Record<string, unknown> = x
    ? isTemporal
      ? { field: 'x', type: 'temporal', timeUnit: timeUnit(x.grain), title: x.label, axis: { grid: false, labelAngle: 0, ...axisText } }
      : { field: 'x', type: 'nominal', title: x.label, sort: null, axis: { labelAngle: horizontal ? 0 : xSeen.length > 6 ? -35 : 0, labelLimit: horizontal ? 220 : 140, ...axisText } }
    : { field: 'x', type: 'nominal', title: null, axis: null }

  const colorEnc = series
    ? { field: 'series', type: 'nominal', title: series.label, scale: { domain: seriesSeen, range: SERIES.slice(0, seriesSeen.length) }, legend: { ...axisText } }
    : { value: SERIES[0] }

  const tooltipBase = [
    ...(x ? [{ field: 'xLabel', title: x.label }] : []),
    ...(series ? [{ field: 'series', title: series.label }] : []),
  ]

  const panelHeight = horizontal ? Math.max(160, xSeen.length * (series ? seriesSeen.length * 14 + 8 : 22)) : measures.length > 1 ? 220 : 340

  const panel = (m: ColumnMeta): Record<string, unknown> => {
    const yEnc = { field: 'value', type: 'quantitative', title: m.label, axis: { format: vegaFormat(m), gridColor: GRID, domain: false, tickColor: GRID, ...axisText } }
    const tt = [...tooltipBase, { field: 'value', title: m.label, format: vegaFormat(m) }]
    const base = { transform: [{ filter: { field: 'measure', equal: m.label } }], width, height: panelHeight }
    if (type === 'pie') {
      return {
        ...base,
        height: 300,
        mark: { type: 'arc', innerRadius: 60, stroke: '#ffffff', strokeWidth: 2 },
        encoding: {
          theta: { field: 'value', type: 'quantitative' },
          color: { field: 'xLabel', type: 'nominal', title: x?.label, scale: { domain: xSeen.slice(0, MAX_CATEGORIES), range: SERIES }, legend: { ...axisText } },
          tooltip: tt,
        },
        view: { stroke: null },
      }
    }
    if (type === 'line') {
      return {
        ...base,
        mark: { type: 'line', strokeWidth: 2, point: { size: 40, filled: true } },
        encoding: { x: xEnc, y: yEnc, color: colorEnc, tooltip: tt },
      }
    }
    const barMark = { type: 'bar', cornerRadiusEnd: 4, stroke: '#ffffff', strokeWidth: 1 }
    if (horizontal) {
      return {
        ...base,
        mark: barMark,
        encoding: {
          y: { ...xEnc, axis: { ...(xEnc.axis as object), labelAngle: 0 } },
          yOffset: series ? { field: 'series' } : undefined,
          x: yEnc,
          color: colorEnc,
          tooltip: tt,
        },
      }
    }
    return {
      ...base,
      mark: barMark,
      encoding: {
        x: xEnc,
        xOffset: series ? { field: 'series' } : undefined,
        y: yEnc,
        color: colorEnc,
        tooltip: tt,
      },
    }
  }

  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: data, ...(isTemporal ? { format: { parse: { x: 'date' } } } : {}) },
    config: {
      font: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      view: { stroke: null },
      axis: { labelFontSize: 11, titleFontSize: 11, titleFontWeight: 'normal' },
      legend: { labelFontSize: 11, titleFontSize: 11, orient: 'top', direction: 'horizontal' },
      scale: { bandPaddingInner: 0.25 },
      background: 'transparent',
    },
  }
  if (measures.length === 1) Object.assign(spec, panel(measures[0]))
  else spec.vconcat = measures.map((m) => ({ ...panel(m), title: { text: m.label, anchor: 'start', fontSize: 12, color: TEXT_SECONDARY, fontWeight: 'normal' } }))
  return spec as VisualizationSpec
}

export function Chart({ type, columns, rows }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - 110)))
    ro.observe(el)
    setWidth(Math.max(200, el.clientWidth - 110))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || !width) return
    let result: Awaited<ReturnType<typeof embed>> | null = null
    let cancelled = false
    embed(el, buildSpec(type, columns, rows, width), { actions: false, renderer: 'svg' })
      .then((r) => {
        if (cancelled) r.finalize()
        else result = r
      })
      .catch((e) => {
        el.innerHTML = `<div class="msg warn">Could not draw this chart: ${String((e as Error).message)}</div>`
      })
    return () => {
      cancelled = true
      result?.finalize()
    }
  }, [type, columns, rows, width])

  const dims = columns.filter((c) => c.kind === 'dimension')
  const seriesDim = dims.find((d) => d.type === 'date') ? dims.find((d) => d.type !== 'date') : dims[1]
  const seriesCount = seriesDim ? new Set(rows.map((r) => String(r[seriesDim.key]))).size : 0
  return (
    <div className="chart-wrap">
      <div ref={ref} style={{ width: '100%', overflow: 'hidden' }} />
      {seriesCount > MAX_CATEGORIES && (
        <div className="msg hint" style={{ marginTop: 8 }}>
          Showing the first {MAX_CATEGORIES} of {seriesCount} {seriesDim?.label.toLowerCase()} values so colors stay distinguishable. Add a filter or use the table for everything.
        </div>
      )}
    </div>
  )
}
