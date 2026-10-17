import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { join } from 'node:path'
import { compile, compileDetail, CompileError, FanOutError } from './compiler'
import { practiceModel } from '../data/practiceModel'
import { emptyQuery, type QuerySpec } from './query'
import { resolveRelativeDate, previousPeriod, previousYear, shiftBetween, addDaysIso } from './dates'

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

// ---------------------------------------------------------------------------
// Period-over-period comparison
// ---------------------------------------------------------------------------

async function sumBilled(start: string, end: string, extra = ''): Promise<number> {
  return scalar(`SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE issued_on >= DATE '${start}' AND issued_on < DATE '${end}' ${extra}`)
}

describe('compile: period comparison', () => {
  const lastQuarter = resolveRelativeDate('last_quarter', NOW)
  const priorQuarter = previousPeriod(lastQuarter)

  it('adds prior, change and change % columns with the right roles and formats', async () => {
    const { compiled } = await run({
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
      compare: 'previous_period',
    })
    expect(compiled.columns.map((c) => c.key)).toEqual(['m0', 'm0_prev', 'm0_chg', 'm0_pct'])
    expect(compiled.columns.map((c) => c.role)).toEqual([undefined, 'previous', 'change', 'change_pct'])
    expect(compiled.columns.map((c) => c.label)).toEqual(['Total Billed', 'Total Billed (prior)', 'Total Billed change', 'Total Billed change %'])
    expect(compiled.columns[1].format).toBe('currency')
    expect(compiled.columns[3].format).toBe('percent')
    expect(compiled.explanation.summary).toContain('compared with the previous period')
    expect(compiled.explanation.compare?.previous).toEqual(priorQuarter)
    expect(compiled.explanation.compare?.description).toContain(priorQuarter.start)
  })

  it('previous period: numbers match raw sums over both ranges', async () => {
    const { rows } = await run({
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
      compare: 'previous_period',
    })
    expect(rows).toHaveLength(1)
    const cur = await sumBilled(lastQuarter.start, lastQuarter.end)
    const prev = await sumBilled(priorQuarter.start, priorQuarter.end)
    expect(cur).toBeGreaterThan(0)
    expect(prev).toBeGreaterThan(0)
    expect(Number(rows[0].m0)).toBeCloseTo(cur, 2)
    expect(Number(rows[0].m0_prev)).toBeCloseTo(prev, 2)
    expect(Number(rows[0].m0_chg)).toBeCloseTo(cur - prev, 2)
    expect(Number(rows[0].m0_pct)).toBeCloseTo((cur - prev) / prev, 6)
  })

  it('same period last year: months line up row by row', async () => {
    const ytd = resolveRelativeDate('year_to_date', NOW)
    const lastYtd = previousYear(ytd)
    const { rows } = await run({
      dimensions: ['invoices.issued_on__month'],
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'year_to_date' }],
      compare: 'previous_year',
    })
    expect(rows.length).toBe(10) // Jan..Oct 2026
    for (const r of rows) {
      const month = String(r.d0).slice(0, 10)
      expect(month >= ytd.start && month < ytd.end).toBe(true)
      const [y, m] = month.split('-').map(Number)
      const pad = (n: number) => String(n).padStart(2, '0')
      const prevMonthStart = `${y - 1}-${pad(m)}-01`
      const prevMonthEnd = m === 12 ? `${y}-01-01` : `${y - 1}-${pad(m + 1)}-01`
      // the prior column for Oct 2026 is Oct 2025, but only up to the equivalent cut-off
      const end = prevMonthEnd < lastYtd.end ? prevMonthEnd : lastYtd.end
      expect(Number(r.m0_prev), `prior for ${month}`).toBeCloseTo(await sumBilled(prevMonthStart, end), 2)
      const curMonthEnd = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`
      expect(Number(r.m0), `current for ${month}`).toBeCloseTo(await sumBilled(month, curMonthEnd < ytd.end ? curMonthEnd : ytd.end), 2)
    }
  })

  it('ratios are recomputed for the prior period, not shifted', async () => {
    const { rows } = await run({
      dimensions: ['partners.name'],
      measures: ['invoices.billed', 'time_entries.standard_value', 'realization'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
      compare: 'previous_period',
    })
    expect(rows.length).toBeGreaterThan(3)
    for (const r of rows) {
      const billedPrev = Number(r.m0_prev)
      const stdPrev = Number(r.m1_prev)
      if (stdPrev > 0) expect(Number(r.x0_prev)).toBeCloseTo(billedPrev / stdPrev, 6)
      expect(Number(r.m0_chg)).toBeCloseTo(Number(r.m0) - Number(r.m0_prev), 2)
      if (Number(r.m0_prev) === 0) expect(r.m0_pct).toBeNull()
    }
  })

  it('a between filter can anchor the comparison (inclusive end becomes exclusive)', async () => {
    const { rows, compiled } = await run({
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'between', value: ['2026-01-01', '2026-03-31'] }],
      compare: 'previous_period',
    })
    const cur = await sumBilled('2026-01-01', '2026-04-01')
    const prevRange = previousPeriod({ start: '2026-01-01', end: '2026-04-01' })
    expect(compiled.explanation.compare?.previous).toEqual(prevRange)
    expect(Number(rows[0].m0)).toBeCloseTo(cur, 2)
    expect(Number(rows[0].m0_prev)).toBeCloseTo(await sumBilled(prevRange.start, prevRange.end), 2)
  })

  it('sorts by the current-period column and respects the limit', async () => {
    const { rows } = await run({
      dimensions: ['clients.name'],
      measures: ['invoices.billed'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'invoices.billed', dir: 'desc' }],
      limit: 5,
      compare: 'previous_year',
    })
    expect(rows).toHaveLength(5)
    const vals = rows.map((r) => Number(r.m0))
    expect([...vals].sort((a, b) => b - a)).toEqual(vals)
  })

  it('refuses to compare without a date filter, in plain language', () => {
    expect(() => compile(practiceModel, { ...emptyQuery(), measures: ['invoices.billed'], compare: 'previous_period' }, { now: NOW })).toThrow(/add a date filter/i)
  })

  it('refuses to group by a different date field than the one filtered', () => {
    expect(() =>
      compile(
        practiceModel,
        {
          ...emptyQuery(),
          dimensions: ['invoices.due_on__month'],
          measures: ['invoices.billed'],
          filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
          compare: 'previous_period',
        },
        { now: NOW },
      ),
    ).toThrow(CompileError)
  })

  it('still refuses fan-out when comparing', () => {
    expect(() =>
      compile(
        practiceModel,
        {
          ...emptyQuery(),
          dimensions: ['staff.name'],
          measures: ['invoices.billed'],
          filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
          compare: 'previous_period',
        },
        { now: NOW },
      ),
    ).toThrow(FanOutError)
  })
})

describe('dates: comparison helpers', () => {
  it('previousYear shifts both ends back one year', () => {
    expect(previousYear({ start: '2026-01-01', end: '2026-10-14' })).toEqual({ start: '2025-01-01', end: '2025-10-14' })
  })
  it('shiftBetween uses months for whole-month ranges and days otherwise', () => {
    expect(shiftBetween({ start: '2025-07-01', end: '2025-10-01' }, { start: '2026-07-01', end: '2026-10-01' })).toEqual({ unit: 'month', n: 12 })
    expect(shiftBetween({ start: '2026-04-01', end: '2026-07-01' }, { start: '2026-07-01', end: '2026-10-01' })).toEqual({ unit: 'month', n: 3 })
    expect(shiftBetween({ start: '2026-09-07', end: '2026-10-14' }, { start: '2026-10-14', end: '2026-11-20' })).toEqual({ unit: 'day', n: 37 })
  })
  it('addDaysIso crosses month and year ends', () => {
    expect(addDaysIso('2026-03-31', 1)).toBe('2026-04-01')
    expect(addDaysIso('2025-12-31', 1)).toBe('2026-01-01')
  })
})

// ---------------------------------------------------------------------------
// Drill to detail
// ---------------------------------------------------------------------------

async function detailRows(spec: Partial<QuerySpec>, row: Record<string, unknown>, measureRef: string, limit?: number) {
  const full = { ...emptyQuery(), ...spec }
  const detail = compileDetail(practiceModel, full, row, measureRef, { now: NOW, limit })
  const reader = await conn.runAndReadAll(detail.sql)
  return { detail, rows: reader.getRowObjectsJson() as Record<string, unknown>[] }
}

describe('compileDetail', () => {
  it('the records behind a filtered measure add up to the cell and honour its definition', async () => {
    const spec: Partial<QuerySpec> = { dimensions: ['clients.name'], measures: ['invoices.outstanding'], sorts: [{ field: 'invoices.outstanding', dir: 'desc' }] }
    const { rows } = await run(spec)
    const cell = rows[0]
    const { detail, rows: recs } = await detailRows(spec, cell, 'invoices.outstanding', 2000)
    expect(detail.title).toBe('Invoices behind Outstanding AR')
    expect(detail.valueKey).toBeDefined()
    const statusKey = detail.columns.find((c) => c.ref === 'invoices.status')!.key
    const clientKey = detail.columns.find((c) => c.ref === 'clients.name')!.key
    expect(recs.length).toBeGreaterThan(0)
    for (const r of recs) {
      expect(['Open', 'Partial']).toContain(r[statusKey])
      expect(r[clientKey]).toBe(cell.d0)
    }
    const sum = recs.reduce((s, r) => s + Number(r[detail.valueKey!]), 0)
    expect(sum).toBeCloseTo(Number(cell.m0), 2)
    expect(detail.conditions.some((c) => /Invoice Status is one of "Open", "Partial" \(part of what "Outstanding AR" means\)/.test(c))).toBe(true)
    expect(detail.conditions[0]).toBe(`Client is "${cell.d0}"`)
  })

  it('a month-grain cell drills to records inside that month, with report filters applied', async () => {
    const spec: Partial<QuerySpec> = {
      dimensions: ['invoices.issued_on__month'],
      measures: ['invoices.billed'],
      filters: [{ field: 'engagements.service_line', op: 'eq', value: 'Tax' }],
    }
    const { rows } = await run(spec)
    const cell = rows[3]
    const { detail, rows: recs } = await detailRows(spec, cell, 'invoices.billed', 5000)
    const dateKey = detail.columns.find((c) => c.ref === 'invoices.issued_on')!.key
    const month = String(cell.d0).slice(0, 7)
    for (const r of recs) expect(String(r[dateKey]).slice(0, 7)).toBe(month)
    const sum = recs.reduce((s, r) => s + Number(r[detail.valueKey!]), 0)
    expect(sum).toBeCloseTo(Number(cell.m0), 2)
    expect(detail.conditions).toContain('Service Line is "Tax"')
    expect(detail.columns.some((c) => c.ref === 'invoices.number')).toBe(true)
  })

  it('follows a two-hop join (partner) and includes that dimension as a column', async () => {
    const spec: Partial<QuerySpec> = {
      dimensions: ['partners.name'],
      measures: ['time_entries.hours'],
      filters: [{ field: 'time_entries.entered_on', op: 'relative_date', value: 'last_month' }],
    }
    const { rows } = await run(spec)
    const cell = rows[0]
    const { detail, rows: recs } = await detailRows(spec, cell, 'time_entries.hours', 10000)
    const partnerKey = detail.columns.find((c) => c.ref === 'partners.name')!.key
    for (const r of recs) expect(r[partnerKey]).toBe(cell.d0)
    const sum = recs.reduce((s, r) => s + Number(r[detail.valueKey!]), 0)
    expect(sum).toBeCloseTo(Number(cell.m0), 1)
    expect(detail.conditions.some((c) => c.startsWith('Work Date is in last month ('))).toBe(true)
  })

  it('count measures list exactly as many records as the cell counts', async () => {
    const spec: Partial<QuerySpec> = { dimensions: ['clients.tier'], measures: ['invoices.count'] }
    const { rows } = await run(spec)
    const cell = rows[0]
    const { detail, rows: recs } = await detailRows(spec, cell, 'invoices.count', 10000)
    expect(detail.valueKey).toBeUndefined()
    expect(recs.length).toBe(Number(cell.m0))
    const t = (await conn.runAndReadAll(detail.totalsSql)).getRowObjectsJson()[0] as Record<string, unknown>
    expect(Number(t.n)).toBe(Number(cell.m0))
    expect(t.total).toBeNull()
  })

  it('respects the row limit and orders newest first', async () => {
    const spec: Partial<QuerySpec> = { measures: ['invoices.billed'] }
    const { rows } = await run(spec)
    const { detail, rows: recs } = await detailRows(spec, rows[0], 'invoices.billed', 7)
    expect(recs).toHaveLength(7)
    const dateKey = detail.columns.find((c) => c.ref === 'invoices.issued_on')!.key
    const ds = recs.map((r) => String(r[dateKey]))
    expect([...ds].sort().reverse()).toEqual(ds)
    // the totals query ignores the limit and reconciles to the cell exactly
    const t = (await conn.runAndReadAll(detail.totalsSql)).getRowObjectsJson()[0] as Record<string, unknown>
    expect(Number(t.n)).toBe(await scalar('SELECT COUNT(*) FROM invoices'))
    expect(Number(t.total)).toBeCloseTo(Number(rows[0].m0), 2)
  })

  it('blank dimension values drill with IS NULL', async () => {
    const spec: Partial<QuerySpec> = { dimensions: ['invoices.sent_via'], measures: ['invoices.billed'] }
    const detail = compileDetail(practiceModel, { ...emptyQuery(), ...spec }, { d0: null }, 'invoices.billed', { now: NOW })
    expect(detail.sql).toMatch(/IS NULL/)
    expect(detail.conditions[0]).toBe('Sent Via is blank')
  })
})
