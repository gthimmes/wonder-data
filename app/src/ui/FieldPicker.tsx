import { useMemo, useState } from 'react'
import { compile, FanOutError } from '../core/compiler'
import type { SemanticModel } from '../core/model'
import type { QuerySpec } from '../core/query'
import { useStore } from './store'

interface FieldItem {
  ref: string
  label: string
  kind: 'dim' | 'measure' | 'metric'
  description?: string
  type?: string
}

interface Group {
  name: string
  label: string
  description?: string
  items: FieldItem[]
}

function buildGroups(model: SemanticModel): Group[] {
  const groups: Group[] = model.tables.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    items: [
      ...t.measures.filter((m) => !m.hidden).map<FieldItem>((m) => ({ ref: `${t.name}.${m.name}`, label: m.label, kind: 'measure', description: m.description })),
      ...t.dimensions.filter((d) => !d.hidden).map<FieldItem>((d) => ({ ref: `${t.name}.${d.name}`, label: d.label, kind: 'dim', description: d.description, type: d.type })),
    ],
  }))
  if (model.metrics?.length) {
    groups.unshift({
      name: '_metrics',
      label: 'Key Metrics',
      description: 'Ratios calculated after totals are added up, so they are always right.',
      items: model.metrics.map((m) => ({ ref: m.name, label: m.label, kind: 'metric', description: m.description })),
    })
  }
  return groups
}

/**
 * Why can't this field be added right now? Returns a reason string or null.
 * Uses the real compiler so the UI and the engine can never disagree.
 */
function blockedReason(model: SemanticModel, query: QuerySpec, item: FieldItem): string | null {
  const trial: QuerySpec =
    item.kind === 'dim'
      ? { ...query, dimensions: [...query.dimensions, item.type === 'date' ? `${item.ref}__month` : item.ref] }
      : { ...query, measures: [...query.measures, item.ref] }
  try {
    compile(model, trial)
    return null
  } catch (e) {
    if (e instanceof FanOutError) return e.message
    return null // other errors (e.g. nothing else selected) are not this field's fault
  }
}

export function FieldPicker() {
  const model = useStore((s) => s.model)
  const query = useStore((s) => s.query)
  const addDimension = useStore((s) => s.addDimension)
  const addMeasure = useStore((s) => s.addMeasure)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => buildGroups(model), [model])
  const inUse = useMemo(() => {
    const s = new Set<string>()
    for (const d of query.dimensions) s.add(d.replace(/__\w+$/, ''))
    for (const m of query.measures) s.add(m)
    return s
  }, [query])

  const q = search.trim().toLowerCase()

  return (
    <aside className="sidebar">
      <div className="search">
        <input placeholder="Search fields…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="fields">
        {groups.map((g) => {
          const items = q ? g.items.filter((i) => i.label.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q)) : g.items
          if (!items.length) return null
          const isCollapsed = !q && collapsed[g.name]
          return (
            <div className="group" key={g.name}>
              <div className="group-title" onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !c[g.name] }))} title={g.description}>
                <span>{isCollapsed ? '▸' : '▾'}</span>
                <span>{g.label}</span>
              </div>
              {!isCollapsed &&
                items.map((item) => {
                  const used = inUse.has(item.ref)
                  const reason = used ? null : blockedReason(model, query, item)
                  const title = reason ?? item.description ?? item.label
                  return (
                    <button
                      key={item.ref}
                      className={`field ${used ? 'in-use' : ''} ${reason ? 'disabled' : ''}`}
                      title={title}
                      disabled={!!reason}
                      onClick={() => {
                        if (reason) return
                        if (item.kind === 'dim') addDimension(item.type === 'date' ? `${item.ref}__month` : item.ref)
                        else addMeasure(item.ref)
                      }}
                    >
                      <span className={`kind ${item.kind}`}>{item.kind === 'dim' ? (item.type === 'date' ? '📅' : 'A') : item.kind === 'metric' ? '%' : 'Σ'}</span>
                      <span className="label">{item.label}</span>
                      {!used && !reason && <span className="add">+ add</span>}
                      {reason && <span className="add" style={{ opacity: 1 }}>⚠</span>}
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
