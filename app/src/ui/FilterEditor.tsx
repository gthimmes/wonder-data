import { useEffect, useMemo, useState } from 'react'
import { findDimension, findMetric, splitRef, type SemanticModel } from '../core/model'
import { RELATIVE_DATES, type Filter, type FilterOp } from '../core/query'
import { distinctValues } from '../core/runtime'
import { useStore } from './store'

interface Props {
  /** Existing filter index, or null to create. */
  index: number | null
  initial?: Filter
  onClose: () => void
}

interface FieldChoice {
  ref: string
  label: string
  type: 'string' | 'number' | 'date' | 'boolean'
  kind: 'dimension' | 'measure' | 'metric'
}

function fieldChoices(model: SemanticModel, measuresInReport: string[]): FieldChoice[] {
  const out: FieldChoice[] = []
  for (const t of model.tables) {
    for (const d of t.dimensions) if (!d.hidden) out.push({ ref: `${t.name}.${d.name}`, label: `${t.label} › ${d.label}`, type: d.type, kind: 'dimension' })
  }
  for (const ref of measuresInReport) {
    const metric = findMetric(model, ref)
    if (metric) out.push({ ref, label: `${metric.label} (calculated)`, type: 'number', kind: 'metric' })
    else {
      const { table, field } = splitRef(ref)
      const t = model.tables.find((x) => x.name === table)
      const m = t?.measures.find((x) => x.name === field)
      if (t && m) out.push({ ref, label: `${t.label} › ${m.label} (total)`, type: 'number', kind: 'measure' })
    }
  }
  return out
}

const OPS: Record<FieldChoice['type'], { op: FilterOp; label: string }[]> = {
  string: [
    { op: 'in', label: 'is any of' },
    { op: 'not_in', label: 'is none of' },
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'contains', label: 'contains' },
    { op: 'not_contains', label: 'does not contain' },
    { op: 'starts_with', label: 'starts with' },
    { op: 'is_null', label: 'is blank' },
    { op: 'not_null', label: 'is not blank' },
  ],
  number: [
    { op: 'gt', label: 'is greater than' },
    { op: 'gte', label: 'is at least' },
    { op: 'lt', label: 'is less than' },
    { op: 'lte', label: 'is at most' },
    { op: 'between', label: 'is between' },
    { op: 'eq', label: 'equals' },
    { op: 'is_null', label: 'is blank' },
  ],
  date: [
    { op: 'relative_date', label: 'is in' },
    { op: 'gte', label: 'is on or after' },
    { op: 'lt', label: 'is before' },
    { op: 'between', label: 'is between' },
    { op: 'is_null', label: 'is blank' },
  ],
  boolean: [
    { op: 'eq', label: 'is' },
  ],
}

export function FilterEditor({ index, initial, onClose }: Props) {
  const model = useStore((s) => s.model)
  const query = useStore((s) => s.query)
  const addFilter = useStore((s) => s.addFilter)
  const updateFilter = useStore((s) => s.updateFilter)
  const choices = useMemo(() => fieldChoices(model, query.measures), [model, query.measures])

  const [field, setField] = useState(initial?.field ?? choices[0]?.ref ?? '')
  const choice = choices.find((c) => c.ref === field) ?? choices[0]
  const ops = OPS[choice?.type ?? 'string']
  const [op, setOp] = useState<FilterOp>(initial?.op ?? ops[0].op)
  const [value, setValue] = useState<string>(() => {
    const v = initial?.value
    if (v === undefined || v === null) return ''
    return Array.isArray(v) ? v.join(', ') : String(v)
  })
  const [value2, setValue2] = useState<string>(() => (Array.isArray(initial?.value) && initial!.value.length > 1 ? String(initial!.value[1]) : ''))
  const [options, setOptions] = useState<string[] | null>(null)

  useEffect(() => {
    if (!ops.some((o) => o.op === op)) setOp(ops[0].op)
  }, [field]) // eslint-disable-line react-hooks/exhaustive-deps

  // Offer real values for string dimensions so users pick rather than type.
  useEffect(() => {
    let alive = true
    setOptions(null)
    if (!choice || choice.kind !== 'dimension' || choice.type !== 'string') return
    const { table, dim } = findDimension(model, choice.ref)
    const expr = dim.sql ? dim.sql.replace(/\{t\}/g, 't') : `t."${dim.name}"`
    const src = /\s/.test(table.sql) ? `(${table.sql})` : `"${table.sql}"`
    distinctValues(`SELECT ${expr} AS v FROM ${src} t`, 300)
      .then((vals) => alive && setOptions(vals.filter((v) => v !== null).map(String)))
      .catch(() => alive && setOptions(null))
    return () => {
      alive = false
    }
  }, [choice?.ref]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!choice) return null
  const needsValue = !['is_null', 'not_null'].includes(op)
  const isRelative = (op as string) === 'relative_date'
  const isList = op === 'in' || op === 'not_in'
  const selectedList = isList ? value.split(',').map((s) => s.trim()).filter(Boolean) : []

  const save = () => {
    let v: Filter['value'] = undefined
    if (needsValue) {
      if (op === 'relative_date') v = value || 'last_12_months'
      else if (op === 'between') v = choice.type === 'number' ? [Number(value), Number(value2)] : [value, value2]
      else if (isList) v = selectedList
      else if (choice.type === 'number' || choice.kind !== 'dimension') v = Number(value)
      else if (choice.type === 'boolean') v = value === 'true'
      else v = value
    }
    const f: Filter = { field: choice.ref, op, value: v }
    if (index === null) addFilter(f)
    else updateFilter(index, f)
    onClose()
  }

  return (
    <div className="popover" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div>
        <label>Field</label>
        <select value={choice.ref} onChange={(e) => { setField(e.target.value); setValue(''); setValue2('') }}>
          {choices.map((c) => (
            <option key={c.ref} value={c.ref}>{c.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label>Condition</label>
        <select value={op} onChange={(e) => { setOp(e.target.value as FilterOp); if (e.target.value === 'relative_date' && !value) setValue('last_12_months') }}>
          {ops.map((o) => (
            <option key={o.op} value={o.op}>{o.label}</option>
          ))}
        </select>
      </div>
      {needsValue && (
        <div>
          <label>Value</label>
          {op === 'relative_date' ? (
            <select value={value || 'last_12_months'} onChange={(e) => setValue(e.target.value)}>
              {RELATIVE_DATES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          ) : choice.type === 'boolean' ? (
            <select value={value || 'true'} onChange={(e) => setValue(e.target.value)}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : op === 'between' ? (
            <div className="row">
              <input type={choice.type === 'date' ? 'date' : 'number'} value={value} onChange={(e) => setValue(e.target.value)} />
              <input type={choice.type === 'date' ? 'date' : 'number'} value={value2} onChange={(e) => setValue2(e.target.value)} />
            </div>
          ) : isList && options ? (
            <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
              {options.map((o) => (
                <label key={o} style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={selectedList.includes(o)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...selectedList, o] : selectedList.filter((x) => x !== o)
                      setValue(next.join(', '))
                    }}
                  />
                  {o}
                </label>
              ))}
            </div>
          ) : (
            <input
              type={choice.type === 'date' && !isRelative ? 'date' : choice.type === 'number' || choice.kind !== 'dimension' ? 'number' : 'text'}
              placeholder={isList ? 'Comma-separated values' : ''}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              list={options ? 'filter-options' : undefined}
              autoFocus
            />
          )}
          {options && !isList && (
            <datalist id="filter-options">
              {options.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          )}
        </div>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={needsValue && !value && !isRelative}>
          {index === null ? 'Add filter' : 'Update'}
        </button>
      </div>
    </div>
  )
}
