import { useEffect, useMemo, useState } from 'react'
import { compileDetail, type DetailQuery } from '../core/compiler'
import { formatValue, toCsv } from '../core/format'
import { findMeasure, findMetric, metricMeasureRefs } from '../core/model'
import { runSql, type ResultSet } from '../core/runtime'
import { useStore } from './store'

const LIMIT = 500

/**
 * Drill to detail: the records behind one number. The point is trust: the
 * rows shown add up to the cell, every condition that selected them is spelled
 * out, and the measure's own definition (e.g. "status is Open or Partial") is
 * visibly part of it.
 */
export function DetailPanel() {
  const model = useStore((s) => s.model)
  const query = useStore((s) => s.query)
  const compiled = useStore((s) => s.compiled)
  const drill = useStore((s) => s.drill)
  const close = useStore((s) => s.closeDrill)
  const [measureRef, setMeasureRef] = useState(drill?.measureRef ?? '')
  const [result, setResult] = useState<ResultSet | null>(null)
  const [totals, setTotals] = useState<{ n: number; total: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Every measure the report touches, including the parts of ratios.
  const measureRefs = useMemo(() => {
    const refs: string[] = []
    for (const m of query.measures) {
      const metric = findMetric(model, m)
      for (const r of metric ? metricMeasureRefs(metric) : [m]) if (!refs.includes(r)) refs.push(r)
    }
    return refs
  }, [model, query.measures])

  useEffect(() => {
    if (drill) setMeasureRef(drill.measureRef)
  }, [drill])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const detail: DetailQuery | null = useMemo(() => {
    if (!drill || !measureRef) return null
    try {
      setError(null)
      return compileDetail(model, query, drill.row, measureRef, { limit: LIMIT })
    } catch (e) {
      setError((e as Error).message)
      return null
    }
  }, [model, query, drill, measureRef])

  useEffect(() => {
    if (!detail) return
    let cancelled = false
    setResult(null)
    setTotals(null)
    // The visible rows are capped; the count and sum over every matching record are not, so the reconciliation is exact.
    Promise.all([runSql(detail.sql), runSql(detail.totalsSql)])
      .then(([r, t]) => {
        if (cancelled) return
        setResult(r)
        const row = t.rows[0] ?? {}
        setTotals({ n: Number(row.n ?? 0), total: row.total == null ? null : Number(row.total) })
      })
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [detail])

  if (!drill) return null

  const cellCol = compiled?.columns.find((c) => c.ref === measureRef && !c.role)
  const cellValue = cellCol ? drill.row[cellCol.key] : undefined
  const sum = detail?.valueKey && totals ? (totals.total ?? 0) : null
  const count = totals?.n ?? result?.rowCount ?? 0
  const reconciles = sum !== null && cellValue != null && Math.abs(sum - Number(cellValue)) < 0.005 * Math.max(1, Math.abs(Number(cellValue)))
  const truncated = count > LIMIT

  const exportCsv = () => {
    if (!detail || !result) return
    const blob = new Blob([toCsv(detail.columns, result.rows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${detail.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Records behind this number">
        <div className="modal-head">
          <div>
            <h3>{detail?.title ?? 'Records'}</h3>
            {measureRefs.length > 1 && (
              <div className="seg" style={{ marginTop: 6 }}>
                {measureRefs.map((r) => (
                  <button key={r} className={r === measureRef ? 'active' : ''} onClick={() => setMeasureRef(r)}>
                    {findMeasure(model, r).measure.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={exportCsv} disabled={!result}>Export CSV</button>
            <button className="btn" onClick={close}>Close</button>
          </div>
        </div>
        <div className="modal-body">
          {detail && (
            <div className="conditions">
              <b>Records where</b>
              {detail.conditions.length ? (
                <ul>
                  {detail.conditions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : (
                <span> no condition applies: every {detail.table.label.toLowerCase()} record is included.</span>
              )}
            </div>
          )}
          {error && <div className="msg err">{error}</div>}
          {!error && !result && <div className="loading"><span className="spinner" /> Loading records…</div>}
          {detail && result && (
            <>
              <div className={`reconcile ${reconciles ? 'ok' : ''}`}>
                {sum !== null && cellCol ? (
                  reconciles ? (
                    <>
                      ✓ These {count.toLocaleString()} records add up to <b>{formatValue(sum, cellCol)}</b>, the number in the report.
                      {truncated && ` Showing the first ${LIMIT.toLocaleString()}; export CSV for all of them.`}
                    </>
                  ) : (
                    <>These {count.toLocaleString()} records add up to {formatValue(sum, cellCol)}; the report shows {formatValue(cellValue, cellCol)}.</>
                  )
                ) : (
                  <>{count.toLocaleString()} record{count === 1 ? '' : 's'}{truncated ? ` (showing the first ${LIMIT.toLocaleString()})` : ''}.</>
                )}
              </div>
              <div className="detail-grid">
                <table className="grid">
                  <thead>
                    <tr>
                      {detail.columns.map((c) => (
                        <th key={c.key} className={c.kind === 'dimension' ? '' : 'num'} style={{ cursor: 'default' }}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        {detail.columns.map((c) => {
                          const v = r[c.key]
                          return (
                            <td key={c.key} className={`${c.kind === 'dimension' ? '' : 'num'} ${v == null ? 'null' : ''}`}>
                              {v == null ? '—' : formatValue(v, c)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
