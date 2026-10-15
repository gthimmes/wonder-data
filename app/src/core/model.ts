/**
 * Semantic model: the single place where business meaning is defined.
 *
 * The report builder never lets a user touch raw SQL or joins. Every field a user
 * can pick is a Dimension or Measure declared here, and every relationship between
 * tables is declared here. The compiler (see compiler.ts) turns a user's QuerySpec
 * into SQL using only these declarations, which is what makes results trustworthy:
 * the same definition of "Total Billed" is used in every report.
 */

export type DimensionType = 'string' | 'number' | 'date' | 'boolean'

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year'
export const TIME_GRAINS: TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year']

export interface Dimension {
  /** Identifier unique within its table, e.g. "issued_at". */
  name: string
  /** Human label shown in the UI, e.g. "Invoice Date". */
  label: string
  type: DimensionType
  /** SQL expression relative to the table alias. Use {t} for the alias. Defaults to the column of the same name. */
  sql?: string
  description?: string
  hidden?: boolean
}

export type Aggregation = 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max'

export interface MeasureFilter {
  /** Dimension on the same table, e.g. "status". */
  dimension: string
  op: 'eq' | 'neq' | 'in' | 'not_in'
  value: string | number | boolean | Array<string | number | boolean>
}

export type NumberFormat = 'number' | 'currency' | 'percent' | 'hours' | 'integer'

export interface Measure {
  name: string
  label: string
  /** Aggregation applied to `sql`. For `count` the sql is ignored. */
  agg: Aggregation
  /** SQL expression relative to the table alias. Use {t} for the alias. Defaults to the column of the same name. */
  sql?: string
  description?: string
  format?: NumberFormat
  /** Row filters applied *before* aggregation, e.g. "paid invoices only". */
  filters?: MeasureFilter[]
  hidden?: boolean
}

/**
 * A derived metric is an arithmetic expression over measures from any table, e.g.
 * realization = billed / standard_value. It is evaluated after aggregation so the
 * ratio of sums is computed, never the sum of ratios.
 */
export interface DerivedMetric {
  name: string
  label: string
  /** Expression referencing fully-qualified measures in braces: "{invoices.total_billed} / {time_entries.standard_value}". */
  expr: string
  description?: string
  format?: NumberFormat
}

export interface Table {
  name: string
  label: string
  /** Physical table or a SQL subquery (without parentheses). */
  sql: string
  primaryKey: string
  description?: string
  dimensions: Dimension[]
  measures: Measure[]
}

export type Cardinality = 'many_to_one' | 'one_to_one' | 'one_to_many'

/**
 * A relationship from one table to another. `many_to_one` means many `from` rows
 * map to one `to` row, so joining `to` onto `from` never multiplies rows. The
 * compiler only ever follows relationships in a direction that cannot fan out.
 */
export interface Relationship {
  from: string
  to: string
  cardinality: Cardinality
  /** Join condition using {from} and {to} as aliases, e.g. "{from}.client_id = {to}.id". */
  on: string
}

export interface SemanticModel {
  name: string
  tables: Table[]
  relationships: Relationship[]
  metrics?: DerivedMetric[]
}

// ---------- helpers ----------

export function getTable(model: SemanticModel, name: string): Table {
  const t = model.tables.find((x) => x.name === name)
  if (!t) throw new Error(`Unknown table "${name}"`)
  return t
}

export function splitRef(ref: string): { table: string; field: string; grain?: TimeGrain } {
  const dot = ref.indexOf('.')
  if (dot < 0) throw new Error(`Field reference "${ref}" must be table.field`)
  const table = ref.slice(0, dot)
  let field = ref.slice(dot + 1)
  let grain: TimeGrain | undefined
  const sep = field.indexOf('__')
  if (sep >= 0) {
    const g = field.slice(sep + 2) as TimeGrain
    if (!TIME_GRAINS.includes(g)) throw new Error(`Unknown time grain "${g}" in "${ref}"`)
    grain = g
    field = field.slice(0, sep)
  }
  return { table, field, grain }
}

export function findDimension(model: SemanticModel, ref: string): { table: Table; dim: Dimension; grain?: TimeGrain } {
  const { table, field, grain } = splitRef(ref)
  const t = getTable(model, table)
  const dim = t.dimensions.find((d) => d.name === field)
  if (!dim) throw new Error(`Unknown dimension "${ref}"`)
  if (grain && dim.type !== 'date') throw new Error(`Time grain on non-date dimension "${ref}"`)
  return { table: t, dim, grain }
}

export function findMeasure(model: SemanticModel, ref: string): { table: Table; measure: Measure } {
  const { table, field, grain } = splitRef(ref)
  if (grain) throw new Error(`Measures cannot have a time grain: "${ref}"`)
  const t = getTable(model, table)
  const measure = t.measures.find((m) => m.name === field)
  if (!measure) throw new Error(`Unknown measure "${ref}"`)
  return { table: t, measure }
}

export function findMetric(model: SemanticModel, name: string): DerivedMetric | undefined {
  return model.metrics?.find((m) => m.name === name)
}

/** Every measure reference inside a derived metric expression. */
export function metricMeasureRefs(metric: DerivedMetric): string[] {
  return [...metric.expr.matchAll(/\{([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)\}/g)].map((m) => m[1])
}

/** True when `ref` names a derived metric rather than a table.measure. */
export function isMetricRef(model: SemanticModel, ref: string): boolean {
  return !ref.includes('.') && !!findMetric(model, ref)
}
