import type { ColumnMeta } from '../core/compiler'

export type ChartType = 'table' | 'bar' | 'line' | 'pie'

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'pie', label: 'Pie' },
]

/**
 * Pick a sensible default chart from the shape of the result. Research finding:
 * novices want the familiar bar/line/table and a one-click override, not a
 * recommendation engine.
 */
export function autoChart(columns: ColumnMeta[]): ChartType {
  const dims = columns.filter((c) => c.kind === 'dimension')
  const measures = columns.filter((c) => c.kind !== 'dimension')
  if (!dims.length || !measures.length) return 'table'
  if (dims.length > 2 || measures.length > 3) return 'table'
  if (dims.some((d) => d.type === 'date')) return 'line'
  if (dims.length === 1 && measures.length === 1) return 'bar'
  return 'table'
}
