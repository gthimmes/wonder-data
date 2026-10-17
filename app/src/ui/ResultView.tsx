import { useMemo } from 'react'
import type { ColumnMeta } from '../core/compiler'
import { formatValue } from '../core/format'
import { findMetric, metricMeasureRefs } from '../core/model'
import { autoChart } from './chartType'
import { Chart } from './Chart'
import { useStore } from './store'

const ROLE_LABEL = { current: 'This period', previous: 'Prior', change: 'Change', change_pct: 'Change %' } as const

/** Signed display for change columns so +$1,200 and -$300 read at a glance. */
function changeText(v: number, col: ColumnMeta): string {
  const s = formatValue(v, col)
  return v > 0 ? `+${s}` : s
}

export function ResultView() {
  const compiled = useStore((s) => s.compiled)
  const compileError = useStore((s) => s.compileError)
  const result = useStore((s) => s.result)
  const running = useStore((s) => s.running)
  const runError = useStore((s) => s.runError)
  const query = useStore((s) => s.query)
  const model = useStore((s) => s.model)
  const chart = useStore((s) => s.chart)
  const dbReady = useStore((s) => s.dbReady)
  const dbError = useStore((s) => s.dbError)
  const setSort = useStore((s) => s.setSort)
  const openDrill = useStore((s) => s.openDrill)

  const effectiveChart = useMemo(() => (chart === 'auto' && compiled ? autoChart(compiled.columns) : chart === 'auto' ? 'table' : chart), [chart, compiled])

  // Which measure a click on a column should drill into (ratios drill into their numerator).
  const drillRefFor = useMemo(() => {
    const map = new Map<string, string>()
    if (!compiled) return map
    let first: string | undefined
    for (const c of compiled.columns) {
      if (c.kind === 'dimension') continue
      const metric = findMetric(model, c.ref)
      const ref = metric ? metricMeasureRefs(metric)[0] : c.ref
      if (ref) {
        map.set(c.key, ref)
        first ??= ref
      }
    }
    for (const c of compiled.columns) if (c.kind === 'dimension' && first) map.set(c.key, first)
    return map
  }, [compiled, model])

  if (dbError) return <div className="result"><div className="msg err"><h3>Could not start the data engine</h3><p>{dbError}</p></div></div>
  if (compileError) {
    const isFanOut = compileError.includes('double-counted')
    return (
      <div className="result">
        <div className={`msg ${isFanOut ? 'warn' : 'hint'}`}>
          <h3>{isFanOut ? 'That combination would give a wrong answer, so it is not allowed' : 'Build your report'}</h3>
          <p>{compileError}</p>
        </div>
      </div>
    )
  }
  if (!compiled) return null
  if (!dbReady) return <div className="loading"><span className="spinner" /> Loading sample data…</div>
  if (runError) return <div className="result"><div className="msg err"><h3>The query failed</h3><p>{runError}</p></div></div>
  if (!result || result.sql !== compiled.sql) return <div className="loading"><span className="spinner" /> Running…</div>

  const { columns } = compiled
  const sort = query.sorts[0]
  const comparing = Boolean(compiled.explanation.compare)
  const dims = columns.filter((c) => c.kind === 'dimension')
  const groups = comparing
    ? columns.filter((c) => c.kind !== 'dimension' && !c.role).map((c) => ({ head: c, cells: columns.filter((x) => x.ref === c.ref && x.kind !== 'dimension') }))
    : []

  const totals: Record<string, number> = {}
  for (const c of columns) {
    if (c.kind !== 'measure' || c.role === 'change_pct') continue
    totals[c.key] = result.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
  }
  for (const c of columns) {
    if (c.kind !== 'measure' || c.role !== 'change_pct') continue
    const base = c.key.replace(/_pct$/, '')
    const prev = totals[`${base}_prev`]
    totals[c.key] = prev ? totals[`${base}_chg`] / prev : NaN
  }
  const showTotals = columns.some((c) => c.kind === 'measure') && dims.length > 0 && result.rows.length > 1
  const canDrill = drillRefFor.size > 0

  const headerCell = (c: ColumnMeta, label: string, extra?: { rowSpan?: number; colSpan?: number; sortable?: boolean; sub?: boolean }) => {
    const sortable = extra?.sortable ?? true
    const active = sortable && sort?.field === c.ref
    return (
      <th
        key={c.key}
        rowSpan={extra?.rowSpan}
        colSpan={extra?.colSpan}
        className={`${c.kind === 'dimension' ? '' : 'num'} ${extra?.colSpan ? 'group' : ''} ${extra?.sub ? 'sub' : ''}`}
        title={sortable ? `Sort by ${c.label}` : undefined}
        style={sortable ? undefined : { cursor: 'default' }}
        onClick={sortable ? () => setSort(active ? (sort.dir === 'desc' ? { field: c.ref, dir: 'asc' } : null) : { field: c.ref, dir: 'desc' }) : undefined}
      >
        {label}
        {active && <span className="arrow">{sort.dir === 'desc' ? '↓' : '↑'}</span>}
      </th>
    )
  }

  return (
    <div className="result">
      <div className="summary">
        <b>{compiled.explanation.summary}</b>
        {running && <span className="spinner" style={{ marginLeft: 8 }} />}
      </div>
      {effectiveChart !== 'table' && result.rows.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Chart type={effectiveChart} columns={columns} rows={result.rows} />
        </div>
      )}
      {result.rows.length === 0 ? (
        <div className="msg hint">No rows match. Try widening a filter.</div>
      ) : (
        <table className={`grid ${canDrill ? 'drillable' : ''}`}>
          <thead>
            {comparing ? (
              <>
                <tr>
                  {dims.map((c) => headerCell(c, c.label, { rowSpan: 2 }))}
                  {groups.map((g) => headerCell(g.head, g.head.label, { colSpan: g.cells.length }))}
                </tr>
                <tr>
                  {groups.flatMap((g) => g.cells.map((c) => headerCell(c, ROLE_LABEL[c.role ?? 'current'], { sortable: !c.role, sub: true })))}
                </tr>
              </>
            ) : (
              <tr>{columns.map((c) => headerCell(c, c.label))}</tr>
            )}
          </thead>
          <tbody>
            {result.rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const v = r[c.key]
                  const n = Number(v)
                  const isChange = c.role === 'change' || c.role === 'change_pct'
                  const tone = isChange && v != null && n !== 0 ? (n > 0 ? 'pos' : 'neg') : ''
                  const ref = drillRefFor.get(c.key)
                  return (
                    <td
                      key={c.key}
                      className={`${c.kind === 'dimension' ? '' : 'num'} ${v == null ? 'null' : ''} ${tone}`}
                      title={ref ? 'Show the records behind this number' : undefined}
                      onClick={ref ? () => openDrill({ row: r, measureRef: ref }) : undefined}
                    >
                      {v == null ? '—' : isChange ? changeText(n, c) : formatValue(v, c)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {showTotals && (
              <tr className="total">
                {columns.map((c, i) => {
                  const t = totals[c.key]
                  const isChange = c.role === 'change' || c.role === 'change_pct'
                  return (
                    <td key={c.key} className={c.kind === 'dimension' ? '' : 'num'}>
                      {i === 0 ? 'Total' : c.kind === 'measure' && Number.isFinite(t) ? (isChange ? changeText(t, c) : formatValue(t, c)) : ''}
                    </td>
                  )
                })}
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="rowcount">
        {result.rowCount.toLocaleString()} rows{query.limit && result.rowCount >= query.limit ? ` (limited to ${query.limit})` : ''} · {Math.round(result.elapsedMs)} ms
        {canDrill && ' · Click a row to see the records behind it.'}
        {showTotals && columns.some((c) => c.kind === 'metric') && ' · Totals are not shown for ratios because a ratio of totals must be recomputed, not summed.'}
      </div>
    </div>
  )
}
