import { useMemo } from 'react'
import { formatValue } from '../core/format'
import { autoChart } from './chartType'
import { Chart } from './Chart'
import { useStore } from './store'

export function ResultView() {
  const compiled = useStore((s) => s.compiled)
  const compileError = useStore((s) => s.compileError)
  const result = useStore((s) => s.result)
  const running = useStore((s) => s.running)
  const runError = useStore((s) => s.runError)
  const query = useStore((s) => s.query)
  const chart = useStore((s) => s.chart)
  const dbReady = useStore((s) => s.dbReady)
  const dbError = useStore((s) => s.dbError)
  const setSort = useStore((s) => s.setSort)

  const effectiveChart = useMemo(() => (chart === 'auto' && compiled ? autoChart(compiled.columns) : chart === 'auto' ? 'table' : chart), [chart, compiled])

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
  const totals: Record<string, number> = {}
  for (const c of columns) {
    if (c.kind !== 'measure') continue
    totals[c.key] = result.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
  }
  const showTotals = columns.some((c) => c.kind === 'measure') && columns.some((c) => c.kind === 'dimension') && result.rows.length > 1

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
        <table className="grid">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.field === c.ref
                return (
                  <th
                    key={c.key}
                    className={c.kind === 'dimension' ? '' : 'num'}
                    title={`Sort by ${c.label}`}
                    onClick={() => setSort(active ? (sort.dir === 'desc' ? { field: c.ref, dir: 'asc' } : null) : { field: c.ref, dir: 'desc' })}
                  >
                    {c.label}
                    {active && <span className="arrow">{sort.dir === 'desc' ? '↓' : '↑'}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const v = r[c.key]
                  return (
                    <td key={c.key} className={`${c.kind === 'dimension' ? '' : 'num'} ${v == null ? 'null' : ''}`}>
                      {v == null ? '—' : formatValue(v, c)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {showTotals && (
              <tr className="total">
                {columns.map((c, i) => (
                  <td key={c.key} className={c.kind === 'dimension' ? '' : 'num'}>
                    {i === 0 ? 'Total' : c.kind === 'measure' ? formatValue(totals[c.key], c) : ''}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="rowcount">
        {result.rowCount.toLocaleString()} rows{query.limit && result.rowCount >= query.limit ? ` (limited to ${query.limit})` : ''} · {Math.round(result.elapsedMs)} ms
        {showTotals && columns.some((c) => c.kind === 'metric') && ' · Totals are not shown for ratios because a ratio of totals must be recomputed, not summed.'}
      </div>
    </div>
  )
}
