import {
  findDimension,
  findMeasure,
  findMetric,
  getTable,
  metricMeasureRefs,
  splitRef,
  type Dimension,
  type Measure,
  type MeasureFilter,
  type NumberFormat,
  type Relationship,
  type SemanticModel,
  type Table,
  type TimeGrain,
} from './model'
import { resolveRelativeDate, type DateRange } from './dates'
import type { Filter, FilterOp, FilterValue, QuerySpec, RelativeDate } from './query'

/**
 * Deterministic compiler from QuerySpec to DuckDB SQL.
 *
 * Design goals, in priority order:
 *  1. Never produce a wrong number. Each measure is aggregated inside its own
 *     subquery that joins only along to-one relationships, so a join can never
 *     multiply rows ("fan-out"). Different measure tables are combined with a
 *     FULL OUTER JOIN on the dimension values.
 *  2. Be explainable. Every compiled query carries a plain-language explanation
 *     and column metadata, so the UI can show where every number came from.
 *  3. Fail loudly and helpfully. When a combination of fields cannot be answered
 *     without double counting, throw a FanOutError that names the fields and
 *     suggests what to do instead.
 */

export interface ColumnMeta {
  key: string
  ref: string
  label: string
  kind: 'dimension' | 'measure' | 'metric'
  type: 'string' | 'number' | 'date' | 'boolean'
  format?: NumberFormat
  grain?: TimeGrain
  /** Table label the field comes from, for the explanation panel. */
  source: string
}

export interface Explanation {
  /** One-sentence summary of the report. */
  summary: string
  /** One line per measure describing its definition and join path. */
  measures: { label: string; definition: string; path: string }[]
  /** Filters rendered in plain language with concrete values. */
  filters: string[]
}

export interface CompiledQuery {
  sql: string
  columns: ColumnMeta[]
  explanation: Explanation
}

export interface CompileOptions {
  /** The "current date" used to resolve relative dates. Defaults to new Date(). */
  now?: Date
}

export class FanOutError extends Error {
  measureLabel: string
  dimensionLabel: string
  measureTable: string
  dimensionTable: string
  suggestion: string
  constructor(measureLabel: string, dimensionLabel: string, measureTable: string, dimensionTable: string, suggestion: string) {
    super(
      `Can't break down "${measureLabel}" by "${dimensionLabel}": each ${measureTable} record can relate to many ${dimensionTable} records, so the total would be double-counted. ${suggestion}`,
    )
    this.name = 'FanOutError'
    this.measureLabel = measureLabel
    this.dimensionLabel = dimensionLabel
    this.measureTable = measureTable
    this.dimensionTable = dimensionTable
    this.suggestion = suggestion
  }
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompileError'
  }
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

function lit(v: string | number | boolean | null, type: Dimension['type']): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  const s = `'${String(v).replace(/'/g, "''")}'`
  if (type === 'date') return `CAST(${s} AS DATE)`
  if (type === 'number') return Number.isFinite(Number(v)) ? String(Number(v)) : 'NULL'
  if (type === 'boolean') return /^(true|1|yes)$/i.test(String(v)) ? 'TRUE' : 'FALSE'
  return s
}

function tableSource(t: Table): string {
  return /\s/.test(t.sql.trim()) ? `(${t.sql})` : q(t.sql)
}

function dimExpr(alias: string, dim: Dimension, grain?: TimeGrain): string {
  const base = dim.sql ? dim.sql.replace(/\{t\}/g, alias) : `${alias}.${q(dim.name)}`
  if (dim.type === 'date') {
    const asDate = `CAST(${base} AS DATE)`
    return grain ? `CAST(date_trunc('${grain}', ${asDate}) AS DATE)` : asDate
  }
  return base
}

function rawExpr(alias: string, sql: string | undefined, name: string): string {
  return sql ? sql.replace(/\{t\}/g, alias) : `${alias}.${q(name)}`
}

function measureFilterCond(alias: string, table: Table, f: MeasureFilter): string {
  const dim = table.dimensions.find((d) => d.name === f.dimension)
  if (!dim) throw new CompileError(`Measure filter references unknown dimension "${table.name}.${f.dimension}"`)
  const e = dimExpr(alias, dim)
  const vals = Array.isArray(f.value) ? f.value : [f.value]
  const list = vals.map((v) => lit(v, dim.type)).join(', ')
  switch (f.op) {
    case 'eq':
      return `${e} = ${list}`
    case 'neq':
      return `${e} <> ${list}`
    case 'in':
      return `${e} IN (${list})`
    case 'not_in':
      return `${e} NOT IN (${list})`
  }
}

function measureExpr(alias: string, table: Table, m: Measure): string {
  const cond = m.filters?.length ? m.filters.map((f) => measureFilterCond(alias, table, f)).join(' AND ') : undefined
  const raw = m.agg === 'count' && !m.sql ? '1' : rawExpr(alias, m.sql, m.name)
  const inner = cond ? `CASE WHEN ${cond} THEN ${raw} END` : raw
  switch (m.agg) {
    case 'sum':
      return `SUM(${inner})`
    case 'count':
      return `COUNT(${inner})`
    case 'count_distinct':
      return `COUNT(DISTINCT ${inner})`
    case 'avg':
      return `AVG(${inner})`
    case 'min':
      return `MIN(${inner})`
    case 'max':
      return `MAX(${inner})`
  }
}

// ---------------------------------------------------------------------------
// Join path resolution
// ---------------------------------------------------------------------------

interface Hop {
  rel: Relationship
  /** The table we arrive at. */
  to: string
}

/**
 * Breadth-first search for a path from `from` to `to` that never fans out:
 * only many_to_one / one_to_one edges in their declared direction, or the
 * reverse of a one_to_many edge (which is many_to_one when walked backwards).
 */
function toOnePath(model: SemanticModel, from: string, to: string): Hop[] | null {
  if (from === to) return []
  const prev = new Map<string, Hop>()
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    const cur = queue.shift()!
    for (const rel of model.relationships) {
      let next: string | null = null
      if (rel.from === cur && (rel.cardinality === 'many_to_one' || rel.cardinality === 'one_to_one')) next = rel.to
      else if (rel.to === cur && (rel.cardinality === 'one_to_many' || rel.cardinality === 'one_to_one')) next = rel.from
      if (!next || seen.has(next)) continue
      seen.add(next)
      prev.set(next, { rel, to: next })
      if (next === to) {
        const path: Hop[] = []
        let n = to
        while (n !== from) {
          const h = prev.get(n)!
          path.unshift(h)
          n = h.rel.from === n ? h.rel.to : h.rel.from
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

/** Tables reachable from `from` without fan-out, for error suggestions. */
function reachableTables(model: SemanticModel, from: string): string[] {
  return model.tables.map((t) => t.name).filter((n) => n !== from && toOnePath(model, from, n) !== null)
}

function joinOn(rel: Relationship, fromAlias: string, toAlias: string): string {
  return rel.on.replace(/\{from\}/g, fromAlias).replace(/\{to\}/g, toAlias)
}

// ---------------------------------------------------------------------------
// Resolved field records
// ---------------------------------------------------------------------------

interface RDim {
  ref: string
  key: string
  table: Table
  dim: Dimension
  grain?: TimeGrain
}

interface RMeasure {
  ref: string
  key: string
  table: Table
  measure: Measure
}

interface RMetric {
  name: string
  key: string
  label: string
  expr: string
  format?: NumberFormat
  description?: string
  refs: string[]
}

interface DimFilter {
  filter: Filter
  table: Table
  dim: Dimension
  grain?: TimeGrain
  range?: DateRange
}

interface PostFilter {
  filter: Filter
  key: string
  label: string
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export function compile(model: SemanticModel, spec: QuerySpec, opts: CompileOptions = {}): CompiledQuery {
  const now = opts.now ?? new Date()

  // --- dimensions
  const dims: RDim[] = spec.dimensions.map((ref, i) => {
    const { table, dim, grain } = findDimension(model, ref)
    return { ref, key: `d${i}`, table, dim, grain }
  })
  const seenDims = new Set<string>()
  for (const d of dims) {
    if (seenDims.has(d.ref)) throw new CompileError(`Dimension "${d.ref}" is listed twice`)
    seenDims.add(d.ref)
  }

  // --- measures & metrics (metrics expand into measures)
  const measures: RMeasure[] = []
  const metrics: RMetric[] = []
  const measureKeyByRef = new Map<string, string>()
  const outputMeasureRefs: string[] = [] // measures explicitly requested, in order
  const addMeasure = (ref: string) => {
    if (measureKeyByRef.has(ref)) return measureKeyByRef.get(ref)!
    const { table, measure } = findMeasure(model, ref)
    const key = `m${measures.length}`
    measures.push({ ref, key, table, measure })
    measureKeyByRef.set(ref, key)
    return key
  }
  for (const ref of spec.measures) {
    const metric = !ref.includes('.') ? findMetric(model, ref) : undefined
    if (metric) {
      const refs = metricMeasureRefs(metric)
      if (!refs.length) throw new CompileError(`Metric "${ref}" references no measures`)
      refs.forEach(addMeasure)
      metrics.push({
        name: metric.name,
        key: `x${metrics.length}`,
        label: metric.label,
        expr: metric.expr,
        format: metric.format,
        description: metric.description,
        refs,
      })
    } else {
      addMeasure(ref)
      outputMeasureRefs.push(ref)
    }
  }

  // --- filters: pre-aggregation (dimension) vs post-aggregation (measure/metric)
  const dimFilters: DimFilter[] = []
  const postFilters: PostFilter[] = []
  for (const f of spec.filters) {
    const metric = !f.field.includes('.') ? findMetric(model, f.field) : undefined
    if (metric) {
      const m = metrics.find((x) => x.name === f.field)
      if (!m) throw new CompileError(`Filter on metric "${f.field}" requires that metric to be in the report`)
      postFilters.push({ filter: f, key: m.key, label: m.label })
      continue
    }
    const { table, field } = splitRef(f.field)
    const t = getTable(model, table)
    if (t.measures.some((m) => m.name === field)) {
      const key = measureKeyByRef.get(f.field)
      if (!key) throw new CompileError(`Filter on measure "${f.field}" requires that measure to be in the report`)
      postFilters.push({ filter: f, key, label: findMeasure(model, f.field).measure.label })
      continue
    }
    const { dim, grain } = findDimension(model, f.field)
    const df: DimFilter = { filter: f, table: t, dim, grain }
    if (f.op === 'relative_date') {
      if (dim.type !== 'date') throw new CompileError(`Relative date filter on non-date field "${f.field}"`)
      df.range = resolveRelativeDate(f.value as RelativeDate, now)
    }
    dimFilters.push(df)
  }

  // --- group measures by source table; each group becomes one aggregated subquery
  const groups = new Map<string, RMeasure[]>()
  for (const m of measures) {
    const arr = groups.get(m.table.name) ?? []
    arr.push(m)
    groups.set(m.table.name, arr)
  }
  // With no measures, we still need one base table to select dimensions from.
  if (!groups.size) {
    if (!dims.length) throw new CompileError('Add at least one field to build a report')
    groups.set(dims[0].table.name, [])
  }

  const explanationMeasures: Explanation['measures'] = []
  const subqueries: { alias: string; sql: string; measureKeys: string[] }[] = []

  for (const [baseName, groupMeasures] of groups) {
    const base = getTable(model, baseName)
    const alias = `t0`
    const aliases = new Map<string, string>([[baseName, alias]])
    const joins: string[] = []
    const pathDescriptions: string[] = []

    const ensureJoined = (target: string, forLabel: string, isDim: boolean): string => {
      if (aliases.has(target)) return aliases.get(target)!
      const path = toOnePath(model, baseName, target)
      if (!path) {
        const reach = reachableTables(model, baseName)
          .map((n) => getTable(model, n).label)
          .join(', ')
        const suggestion = reach
          ? `Fields from ${base.label}${reach ? ', ' + reach : ''} are safe to combine with it.`
          : `Only fields from ${base.label} can be combined with it.`
        const measureLabel = groupMeasures.map((m) => m.measure.label).join(', ') || base.label
        throw new FanOutError(
          isDim ? measureLabel : measureLabel,
          forLabel,
          base.label,
          getTable(model, target).label,
          suggestion,
        )
      }
      let cur = baseName
      for (const hop of path) {
        const next = hop.to
        if (!aliases.has(next)) {
          const a = `t${aliases.size}`
          aliases.set(next, a)
          const fromAlias = aliases.get(cur)!
          const on =
            hop.rel.from === cur ? joinOn(hop.rel, fromAlias, a) : joinOn(hop.rel, a, fromAlias)
          joins.push(`LEFT JOIN ${tableSource(getTable(model, next))} ${a} ON ${on}`)
          pathDescriptions.push(`${getTable(model, cur).label} → ${getTable(model, next).label}`)
        }
        cur = next
      }
      return aliases.get(target)!
    }

    const selectParts: string[] = []
    for (const d of dims) {
      const a = ensureJoined(d.table.name, d.dim.label, true)
      selectParts.push(`${dimExpr(a, d.dim, d.grain)} AS ${d.key}`)
    }
    for (const m of groupMeasures) {
      selectParts.push(`${measureExpr(alias, m.table, m.measure)} AS ${m.key}`)
    }
    const whereParts: string[] = []
    for (const f of dimFilters) {
      const a = ensureJoined(f.table.name, f.dim.label, true)
      const cond = filterCond(dimExpr(a, f.dim, f.grain), f)
      if (cond) whereParts.push(cond)
    }

    const groupBy = dims.length ? `\nGROUP BY ${dims.map((d) => d.key).join(', ')}` : ''
    const where = whereParts.length ? `\nWHERE ${whereParts.join('\n  AND ')}` : ''
    const sql =
      `SELECT ${selectParts.join(',\n       ')}\nFROM ${tableSource(base)} ${alias}` +
      (joins.length ? '\n' + joins.join('\n') : '') +
      where +
      groupBy

    subqueries.push({ alias: `q${subqueries.length}`, sql, measureKeys: groupMeasures.map((m) => m.key) })

    for (const m of groupMeasures) {
      explanationMeasures.push({
        label: m.measure.label,
        definition: describeMeasure(m.measure, m.table),
        path: pathDescriptions.length ? pathDescriptions.join('; ') : `from ${base.label}`,
      })
    }
  }

  // --- combine subqueries
  const columns: ColumnMeta[] = []
  const outerSelect: string[] = []
  for (const d of dims) {
    const expr =
      subqueries.length === 1 ? `${subqueries[0].alias}.${d.key}` : `COALESCE(${subqueries.map((s) => `${s.alias}.${d.key}`).join(', ')})`
    outerSelect.push(`${expr} AS ${d.key}`)
    columns.push({
      key: d.key,
      ref: d.ref,
      label: d.grain ? `${d.dim.label} (${grainLabel(d.grain)})` : d.dim.label,
      kind: 'dimension',
      type: d.dim.type,
      grain: d.grain,
      source: d.table.label,
    })
  }
  const measureOwner = new Map<string, string>()
  for (const s of subqueries) for (const k of s.measureKeys) measureOwner.set(k, s.alias)
  for (const ref of outputMeasureRefs) {
    const m = measures.find((x) => x.ref === ref)!
    outerSelect.push(`${measureOwner.get(m.key)}.${m.key} AS ${m.key}`)
    columns.push({
      key: m.key,
      ref: m.ref,
      label: m.measure.label,
      kind: 'measure',
      type: 'number',
      format: m.measure.format ?? defaultFormat(m.measure),
      source: m.table.label,
    })
  }
  for (const x of metrics) {
    const expr = x.expr.replace(/\{([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)\}/g, (_, ref) => {
      const key = measureKeyByRef.get(ref)!
      return `CAST(${measureOwner.get(key)}.${key} AS DOUBLE)`
    })
    outerSelect.push(`(${safeDivision(expr)}) AS ${x.key}`)
    columns.push({ key: x.key, ref: x.name, label: x.label, kind: 'metric', type: 'number', format: x.format ?? 'number', source: 'Calculated' })
    explanationMeasures.push({
      label: x.label,
      definition: x.description ?? describeMetricExpr(model, x),
      path: 'calculated after aggregation',
    })
  }

  let from = `(\n${indent(subqueries[0].sql)}\n) ${subqueries[0].alias}`
  for (let i = 1; i < subqueries.length; i++) {
    const s = subqueries[i]
    const on = dims.length
      ? dims.map((d) => `${subqueries[0].alias}.${d.key} IS NOT DISTINCT FROM ${s.alias}.${d.key}`).join(' AND ')
      : 'TRUE'
    from += `\nFULL OUTER JOIN (\n${indent(s.sql)}\n) ${s.alias} ON ${on}`
  }

  // post-aggregation filters wrap the join in one more level so metrics are filterable by alias
  const having: string[] = []
  for (const pf of postFilters) {
    const cond = filterCond(pf.key, { filter: pf.filter, table: undefined as unknown as Table, dim: { name: '', label: '', type: 'number' } })
    if (cond) having.push(cond)
  }

  const orderBy = spec.sorts.length
    ? `\nORDER BY ${spec.sorts
        .map((s) => {
          const col = columns.find((c) => c.ref === s.field)
          if (!col) throw new CompileError(`Sort field "${s.field}" is not in the report`)
          return `${col.key} ${s.dir.toUpperCase()} NULLS LAST`
        })
        .join(', ')}`
    : dims.length
      ? `\nORDER BY ${dims.map((d) => `${d.key} ASC NULLS LAST`).join(', ')}`
      : ''
  const limit = spec.limit ? `\nLIMIT ${Math.max(1, Math.floor(spec.limit))}` : ''

  const inner = `SELECT ${outerSelect.join(',\n       ')}\nFROM ${from}`
  const sql = having.length
    ? `SELECT * FROM (\n${indent(inner)}\n) r\nWHERE ${having.join('\n  AND ')}${orderBy}${limit}`
    : `${inner}${orderBy}${limit}`

  const explanation: Explanation = {
    summary: summarize(columns, dimFilters, postFilters, spec),
    measures: explanationMeasures,
    filters: [
      ...dimFilters.map((f) => describeFilter(f.dim.label, f.filter, f.range, f.grain)),
      ...postFilters.map((f) => describeFilter(f.label, f.filter)),
    ],
  }

  return { sql, columns, explanation }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function filterCond(expr: string, f: DimFilter): string | null {
  const { op, value } = f.filter
  const type = f.dim.type
  const arr = (v: FilterValue | undefined): Array<string | number | boolean> =>
    Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
  const one = (v: FilterValue | undefined) => lit(Array.isArray(v) ? v[0] : (v as string | number | boolean | null), type)
  switch (op) {
    case 'eq':
      return `${expr} = ${one(value)}`
    case 'neq':
      return `${expr} <> ${one(value)}`
    case 'in': {
      const vals = arr(value)
      return vals.length ? `${expr} IN (${vals.map((v) => lit(v, type)).join(', ')})` : null
    }
    case 'not_in': {
      const vals = arr(value)
      return vals.length ? `${expr} NOT IN (${vals.map((v) => lit(v, type)).join(', ')})` : null
    }
    case 'gt':
      return `${expr} > ${one(value)}`
    case 'gte':
      return `${expr} >= ${one(value)}`
    case 'lt':
      return `${expr} < ${one(value)}`
    case 'lte':
      return `${expr} <= ${one(value)}`
    case 'between': {
      const vals = arr(value)
      if (vals.length < 2) return null
      return `${expr} BETWEEN ${lit(vals[0], type)} AND ${lit(vals[1], type)}`
    }
    case 'contains':
      return `${expr} ILIKE ${lit('%' + String(Array.isArray(value) ? value[0] : value) + '%', 'string')}`
    case 'not_contains':
      return `${expr} NOT ILIKE ${lit('%' + String(Array.isArray(value) ? value[0] : value) + '%', 'string')}`
    case 'starts_with':
      return `${expr} ILIKE ${lit(String(Array.isArray(value) ? value[0] : value) + '%', 'string')}`
    case 'is_null':
      return `${expr} IS NULL`
    case 'not_null':
      return `${expr} IS NOT NULL`
    case 'relative_date': {
      if (!f.range) return null
      return `${expr} >= CAST('${f.range.start}' AS DATE) AND ${expr} < CAST('${f.range.end}' AS DATE)`
    }
  }
}

// ---------------------------------------------------------------------------
// Explanation helpers
// ---------------------------------------------------------------------------

const OP_WORDS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is not one of',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  is_null: 'is blank',
  not_null: 'is not blank',
  relative_date: 'is in',
}

export function describeFilter(label: string, f: Filter, range?: DateRange, grain?: TimeGrain): string {
  const name = grain ? `${label} (${grainLabel(grain)})` : label
  if (f.op === 'relative_date') {
    const preset = String(f.value).replace(/_/g, ' ')
    return range ? `${name} is in ${preset} (${range.start} to ${range.end}, exclusive)` : `${name} is in ${preset}`
  }
  if (f.op === 'is_null' || f.op === 'not_null') return `${name} ${OP_WORDS[f.op]}`
  const vals = Array.isArray(f.value) ? f.value : [f.value]
  if (f.op === 'between') return `${name} is between ${vals[0]} and ${vals[1]}`
  return `${name} ${OP_WORDS[f.op]} ${vals.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ')}`
}

function describeMeasure(m: Measure, t: Table): string {
  if (m.description) return m.description
  const what = m.agg === 'count' && !m.sql ? `${t.label} records` : m.sql ?? m.name
  const aggWord: Record<Measure['agg'], string> = {
    sum: 'sum of',
    count: 'count of',
    count_distinct: 'number of distinct',
    avg: 'average of',
    min: 'minimum of',
    max: 'maximum of',
  }
  const filt = m.filters?.length
    ? ` where ${m.filters.map((f) => `${f.dimension} ${f.op.replace('_', ' ')} ${Array.isArray(f.value) ? f.value.join('/') : f.value}`).join(' and ')}`
    : ''
  return `${aggWord[m.agg]} ${what} in ${t.label}${filt}`
}

function describeMetricExpr(model: SemanticModel, x: RMetric): string {
  return x.expr.replace(/\{([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)\}/g, (_, ref) => findMeasure(model, ref).measure.label)
}

export function grainLabel(g: TimeGrain): string {
  return { day: 'by day', week: 'by week', month: 'by month', quarter: 'by quarter', year: 'by year' }[g]
}

function summarize(columns: ColumnMeta[], dimFilters: DimFilter[], postFilters: PostFilter[], spec: QuerySpec): string {
  const ms = columns.filter((c) => c.kind !== 'dimension').map((c) => c.label)
  const ds = columns.filter((c) => c.kind === 'dimension').map((c) => c.label)
  let s = ms.length ? joinWords(ms) : 'Distinct values'
  if (ds.length) s += ` by ${joinWords(ds)}`
  const n = dimFilters.length + postFilters.length
  if (n) s += `, with ${n} filter${n === 1 ? '' : 's'}`
  if (spec.sorts.length) {
    const first = spec.sorts[0]
    const col = columns.find((c) => c.ref === first.field)
    if (col) s += `, sorted by ${col.label} ${first.dir === 'desc' ? 'high to low' : 'low to high'}`
  }
  if (spec.limit) s += `, up to ${spec.limit} rows`
  return s + '.'
}

function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]
}

function defaultFormat(m: Measure): NumberFormat {
  return m.agg === 'count' || m.agg === 'count_distinct' ? 'integer' : 'number'
}

/** Rewrite `a / b` as `a / NULLIF(b, 0)` for the simple binary case so ratios never error on zero. */
function safeDivision(expr: string): string {
  // Only handles top-level "X / Y" where Y is a single CAST(...) term, which is what metric expansion produces.
  return expr.replace(/\/\s*(CAST\([^()]*\([^()]*\)[^()]*\)|CAST\([^()]*\)|[A-Za-z0-9_.]+)/g, (_, rhs) => `/ NULLIF(${rhs}, 0)`)
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
}
