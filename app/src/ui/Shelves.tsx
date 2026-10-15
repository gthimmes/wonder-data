import { useState } from 'react'
import { describeFilter, grainLabel } from '../core/compiler'
import { resolveRelativeDate } from '../core/dates'
import { findDimension, findMeasure, findMetric, TIME_GRAINS, type TimeGrain } from '../core/model'
import { grainOf, stripGrain, type Filter, type RelativeDate } from '../core/query'
import { FilterEditor } from './FilterEditor'
import { useStore } from './store'

function filterLabel(filter: Filter, model: ReturnType<typeof useStore.getState>['model']): string {
  const metric = findMetric(model, filter.field)
  if (metric) return describeFilter(metric.label, filter)
  try {
    const { table, dim, grain } = findDimension(model, filter.field)
    void table
    const range = filter.op === 'relative_date' ? resolveRelativeDate(filter.value as RelativeDate, new Date()) : undefined
    return describeFilter(dim.label, filter, range, grain)
  } catch {
    try {
      return describeFilter(findMeasure(model, filter.field).measure.label, filter)
    } catch {
      return filter.field
    }
  }
}

export function Shelves() {
  const model = useStore((s) => s.model)
  const query = useStore((s) => s.query)
  const removeDimension = useStore((s) => s.removeDimension)
  const replaceDimension = useStore((s) => s.replaceDimension)
  const removeMeasure = useStore((s) => s.removeMeasure)
  const removeFilter = useStore((s) => s.removeFilter)
  const setSort = useStore((s) => s.setSort)
  const [editing, setEditing] = useState<{ index: number | null; filter?: Filter } | null>(null)

  const sort = query.sorts[0]
  const sortButton = (ref: string) => {
    const active = sort?.field === ref
    return (
      <button
        className={`sort ${active ? 'active' : ''}`}
        title="Sort by this field"
        onClick={() => setSort(active ? (sort.dir === 'desc' ? { field: ref, dir: 'asc' } : null) : { field: ref, dir: 'desc' })}
      >
        {active ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'}
      </button>
    )
  }

  return (
    <div className="shelves">
      <div className="shelf">
        <span className="shelf-label">Group by</span>
        {query.dimensions.length === 0 && <span className="empty">Pick a field on the left, e.g. Client or Invoice Date</span>}
        {query.dimensions.map((ref) => {
          const { dim, grain } = findDimension(model, ref)
          return (
            <span className="pill dim" key={ref}>
              {dim.label}
              {dim.type === 'date' && (
                <select value={grain ?? 'day'} onChange={(e) => replaceDimension(ref, `${stripGrain(ref)}__${e.target.value as TimeGrain}`)} title="Time grain">
                  {TIME_GRAINS.map((g) => (
                    <option key={g} value={g}>{grainLabel(g)}</option>
                  ))}
                </select>
              )}
              {sortButton(ref)}
              <button className="x" onClick={() => removeDimension(ref)} title="Remove">×</button>
            </span>
          )
        })}
      </div>
      <div className="shelf">
        <span className="shelf-label">Show</span>
        {query.measures.length === 0 && <span className="empty">Pick a number to show, e.g. Total Billed or Hours</span>}
        {query.measures.map((ref) => {
          const metric = findMetric(model, ref)
          const label = metric ? metric.label : findMeasure(model, ref).measure.label
          return (
            <span className={`pill ${metric ? 'metric' : 'measure'}`} key={ref} title={metric?.description ?? findMeasureDesc(model, ref)}>
              {label}
              {sortButton(ref)}
              <button className="x" onClick={() => removeMeasure(ref)} title="Remove">×</button>
            </span>
          )
        })}
      </div>
      <div className="shelf">
        <span className="shelf-label">Filters</span>
        {query.filters.map((f, i) => (
          <span className="pill filter" key={i} onClick={() => setEditing({ index: i, filter: f })} title="Click to edit">
            {filterLabel(f, model)}
            <button
              className="x"
              onClick={(e) => {
                e.stopPropagation()
                removeFilter(i)
              }}
              title="Remove"
            >
              ×
            </button>
          </span>
        ))}
        <button className="addbtn" onClick={() => setEditing({ index: null })}>+ Add filter</button>
        {editing && (
          <div style={{ position: 'absolute', top: '100%', left: 80 }}>
            <FilterEditor index={editing.index} initial={editing.filter} onClose={() => setEditing(null)} />
          </div>
        )}
      </div>
    </div>
  )
}

function findMeasureDesc(model: ReturnType<typeof useStore.getState>['model'], ref: string): string | undefined {
  try {
    return findMeasure(model, ref).measure.description
  } catch {
    return undefined
  }
}

export { grainOf }
