import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { join } from 'node:path'
import { compile, FanOutError } from './compiler'
import { practiceModel } from '../data/practiceModel'
import { emptyQuery, type QuerySpec } from './query'
import { resolveRelativeDate, previousPeriod } from './dates'

const NOW = new Date('2026-10-13T12:00:00Z')
const dataDir = join(process.cwd(), 'public', 'data')

let conn: DuckDBConnection
async function run(spec: Partial<QuerySpec>) {
  const full = { ...emptyQuery(), ...spec }
  const compiled = compile(practiceModel, full, { now: NOW })
  const reader = await conn.runAndReadAll(compiled.sql)
  return { compiled, rows: reader.getRowObjectsJson() as Record<string, unknown>[] }
}
async function scalar(sql: string): Promise<number> {
  const reader = await conn.runAndReadAll(sql)
  const rows = reader.getRowObjectsJson() as Record<string, unknown>[]
  return Number(Object.values(rows[0])[0])
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()
  for (const t of ['clients', 'staff', 'engagements', 'time_entries', 'invoices', 'payments']) {
    const p = join(dataDir, `${t}.csv`).replace(/\\/g, '/')
    await conn.run(`CREATE TABLE ${t} AS SELECT * FROM read_csv('${p}', header=true)`)
  }
})
afterAll(() => conn?.closeSync())

describe('compile: single fact', () => {
  it('sums a measure with no dimensions', async () => {
    const { rows, compiled } = await run({ measures: ['invoices.billed'] })
    expect(rows).toHaveLength(1)
    const expected = await scalar('SELECT SUM(amount) FROM invoices')
    expect(Number(rows[0].m0)).toBeCloseTo(expected, 2)
    expect(compiled.columns[0]).toMatchObject({ kind: 'measure', label: 'Total Billed', format: 'currency' })
  })

  it('groups by a dimension reached through a to-one join', async () => {
    const { rows } = await run({ measures: ['invoices.billed'], dimensions: ['clients.industry'] })
    const total = rows.reduce((s, r) => s + Number(r.m0), 0)
    const expected = await scalar('SELECT SUM(amount) FROM invoices')
    expect(total).toBeCloseTo(expected, 2)
    expect(rows.length).toBe(10)
  })

  it('follows a two-hop join path (time -> engagements -> clients -> partners)', async () => {
    const { rows, compiled } = await run({ measures: ['time_entries.hours'], dimensions: ['partners.name'] })
    expect(compiled.sql).toContain('LEFT JOIN')
    const total = rows.reduce((s, r) => s + Number(r.m0), 0)
    const expected = await scalar('SELECT SUM(hours) FROM time_entries')
    expect(total).toBeCloseTo(expected, 2)
    expect(compiled.explanation.measures[0].path).toContain('Time → Engagements')
  })

  it('applies measure-level filters (billable hours only)', async () => {
    const { rows } = await run({ measures: ['time_entries.hours', 'time_entries.billable_hours'] })
    const all = await scalar('SELECT SUM(hours) FROM time_entries')
    const billable = await scalar('SELECT SUM(hours) FROM time_entries WHERE billable')
    expect(Number(rows[0].m0)).toBeCloseTo(all, 2)
    expect(Number(rows[0].m1)).toBeCloseTo(billable, 2)
    expect(billable).toBeLessThan(all)
  })

  it('truncates dates to a grain and sorts', async () => {
    const { rows, compiled } = await run({
      measures: ['invoices.billed'],
      dimensions: ['invoices.issued_on__month'],
      sorts: [{ field: 'invoices.issued_on__month', dir: 'desc' }],
      limit: 3,
    })
    expect(rows).toHaveLength(3)
    expect(String(rows[0].d0) >= String(rows[1].d0)).toBe(true)
    expect(String(rows[0].d0)).toMatch(/^\d{4}-\d{2}-01$/)
    expect(compiled.columns[0].label).toBe('Invoice Date (by month)')
  })

  it('resolves relative date filters to concrete ranges', async () => {
    const { rows, compiled } = await run({
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
    })
    const expected = await scalar("SELECT SUM(amount) FROM invoices WHERE issued_on >= DATE '2026-07-01' AND issued_on < DATE '2026-10-01'")
    expect(Number(rows[0].m0)).toBeCloseTo(expected, 2)
    expect(compiled.explanation.filters[0]).toContain('2026-07-01 to 2026-10-01')
  })

  it('supports string and list filters', async () => {
    const { rows } = await run({
      measures: ['invoices.count'],
      filters: [
        { field: 'invoices.status', op: 'in', value: ['Open', 'Partial'] },
        { field: 'clients.name', op: 'contains', value: 'summit' },
      ],
    })
    const expected = await scalar(
      "SELECT COUNT(*) FROM invoices i JOIN clients c ON i.client_id = c.id WHERE i.status IN ('Open','Partial') AND c.name ILIKE '%summit%'",
    )
    expect(Number(rows[0].m0)).toBe(expected)
  })
})

describe('compile: multi fact', () => {
  it('combines measures from two fact tables without double counting', async () => {
    const { rows, compiled } = await run({
      measures: ['invoices.billed', 'time_entries.hours'],
      dimensions: ['clients.name'],
    })
    expect(compiled.sql).toContain('FULL OUTER JOIN')
    const billed = rows.reduce((s, r) => s + Number(r.m0 ?? 0), 0)
    const hours = rows.reduce((s, r) => s + Number(r.m1 ?? 0), 0)
    expect(billed).toBeCloseTo(await scalar('SELECT SUM(amount) FROM invoices'), 2)
    expect(hours).toBeCloseTo(await scalar('SELECT SUM(hours) FROM time_entries'), 2)
  })

  it('computes a ratio metric as ratio-of-sums', async () => {
    const { rows, compiled } = await run({ measures: ['realization'], dimensions: ['engagements.service_line'] })
    expect(compiled.columns[1]).toMatchObject({ kind: 'metric', label: 'Realization %', format: 'percent' })
    for (const r of rows) {
      const billed = await scalar(`SELECT SUM(i.amount) FROM invoices i JOIN engagements e ON i.engagement_id = e.id WHERE e.service_line = '${r.d0}'`)
      const std = await scalar(`SELECT SUM(t.hours*t.rate) FROM time_entries t JOIN engagements e ON t.engagement_id = e.id WHERE e.service_line = '${r.d0}' AND t.billable`)
      expect(Number(r.x0)).toBeCloseTo(billed / std, 6)
    }
  })

  it('filters on a metric after aggregation', async () => {
    const { rows } = await run({
      measures: ['realization', 'invoices.billed'],
      dimensions: ['clients.name'],
      filters: [{ field: 'realization', op: 'lt', value: 0.8 }],
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Number(r.x0)).toBeLessThan(0.8)
  })

  it('divides by zero safely (NULL, not error)', async () => {
    const { rows } = await run({
      measures: ['collection_rate'],
      dimensions: ['clients.name'],
      filters: [{ field: 'clients.status', op: 'eq', value: 'Former' }],
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('compile: safety', () => {
  it('refuses to fan out a client count by invoice month', () => {
    expect(() =>
      compile(practiceModel, { ...emptyQuery(), measures: ['clients.count'], dimensions: ['invoices.issued_on__month'] }, { now: NOW }),
    ).toThrow(FanOutError)
  })

  it('names the fields in the fan-out message and suggests alternatives', () => {
    try {
      compile(practiceModel, { ...emptyQuery(), measures: ['engagements.budget_hours'], dimensions: ['staff.name'] }, { now: NOW })
      throw new Error('expected FanOutError')
    } catch (e) {
      expect(e).toBeInstanceOf(FanOutError)
      const msg = (e as Error).message
      expect(msg).toContain('Budgeted Hours')
      expect(msg).toContain('Staff Member')
      expect(msg).toContain('double-counted')
    }
  })

  it('rejects unknown fields', () => {
    expect(() => compile(practiceModel, { ...emptyQuery(), measures: ['invoices.nope'] })).toThrow(/Unknown measure/)
  })

  it('escapes quotes in filter values', async () => {
    const { rows } = await run({ measures: ['invoices.count'], filters: [{ field: 'clients.name', op: 'eq', value: "O'Brien" }] })
    expect(Number(rows[0].m0)).toBe(0)
  })

  it('produces a readable summary', () => {
    const c = compile(
      practiceModel,
      {
        dimensions: ['clients.name', 'invoices.issued_on__month'],
        measures: ['invoices.billed', 'realization'],
        filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
        sorts: [{ field: 'invoices.billed', dir: 'desc' }],
        limit: 50,
      },
      { now: NOW },
    )
    expect(c.explanation.summary).toBe(
      'Total Billed and Realization % by Client and Invoice Date (by month), with 1 filter, sorted by Total Billed high to low, up to 50 rows.',
    )
  })
})

describe('dates', () => {
  it('resolves presets relative to a fixed now', () => {
    expect(resolveRelativeDate('this_month', NOW)).toEqual({ start: '2026-10-01', end: '2026-11-01' })
    expect(resolveRelativeDate('last_month', NOW)).toEqual({ start: '2026-09-01', end: '2026-10-01' })
    expect(resolveRelativeDate('this_week', NOW)).toEqual({ start: '2026-10-12', end: '2026-10-19' })
    expect(resolveRelativeDate('year_to_date', NOW)).toEqual({ start: '2026-01-01', end: '2026-10-14' })
    expect(resolveRelativeDate('last_12_months', NOW)).toEqual({ start: '2025-11-01', end: '2026-10-14' })
  })
  it('shifts a range back by its own length', () => {
    expect(previousPeriod({ start: '2026-09-01', end: '2026-10-01' })).toEqual({ start: '2026-08-02', end: '2026-09-01' })
  })
})
