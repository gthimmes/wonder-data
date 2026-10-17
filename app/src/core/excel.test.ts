import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { compile } from './compiler'
import { practiceModel } from '../data/practiceModel'
import { emptyQuery } from './query'
import { buildExcelBuffer, buildWorkbook, cellValue, numberFormat } from './excel'

const NOW = new Date('2026-10-13T12:00:00Z')

const compiled = compile(
  practiceModel,
  {
    ...emptyQuery(),
    dimensions: ['invoices.issued_on__month', 'engagements.service_line'],
    measures: ['invoices.billed', 'invoices.count', 'realization'],
    filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
    sorts: [{ field: 'invoices.billed', dir: 'desc' }],
    limit: 50,
  },
  { now: NOW },
)
// Shaped like what the runtime returns: ISO dates, plain numbers, nulls for missing ratios.
const rows = [
  { d0: '2026-07-01', d1: 'Tax', m0: 125000.5, m1: 42, x0: 0.93 },
  { d0: '2026-07-01', d1: 'Audit', m0: 80000, m1: 10, x0: null },
  { d0: '2026-08-01', d1: 'Tax', m0: 64000.25, m1: 21, x0: 1.02 },
]

describe('excel export', () => {
  it('maps formats to Excel number formats', () => {
    expect(numberFormat({ ...compiled.columns[2], format: 'currency' })).toContain('$#,##0')
    expect(numberFormat({ ...compiled.columns[2], format: 'percent' })).toContain('0.0%')
    expect(numberFormat({ ...compiled.columns[2], format: 'integer' })).toBe('#,##0')
    expect(numberFormat({ ...compiled.columns[2], format: 'hours' })).toBe('#,##0.0')
  })

  it('writes real dates for day/month/year grains and labels for quarters', () => {
    const month = compiled.columns[0]
    expect(cellValue('2026-07-01', month)).toEqual(new Date(Date.UTC(2026, 6, 1)))
    expect(cellValue('2026-07-01', { ...month, grain: 'quarter' })).toBe('Q3 2026')
    expect(cellValue(null, month)).toBeNull()
    expect(cellValue(true, { ...month, type: 'boolean' })).toBe('Yes')
    expect(cellValue('12.5', compiled.columns[2])).toBe(12.5)
  })

  it('produces a workbook with a formatted report sheet and live totals', async () => {
    const wb = await buildWorkbook({ title: 'Billing by month', compiled, rows, generatedAt: NOW })
    const ws = wb.getWorksheet('Report')!
    expect(ws.getCell('A1').value).toBe('Billing by month')
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('A2').value).toBe(compiled.explanation.summary)
    // header row
    expect(ws.getRow(4).getCell(1).value).toBe('Invoice Date (by month)')
    expect(ws.getRow(4).getCell(3).value).toBe('Total Billed')
    expect(ws.getRow(4).getCell(3).font?.bold).toBe(true)
    // first data row: a real date with a month format, currency with a currency format
    const r5 = ws.getRow(5)
    expect(r5.getCell(1).value).toEqual(new Date(Date.UTC(2026, 6, 1)))
    expect(r5.getCell(1).numFmt).toBe('mmm yyyy')
    expect(r5.getCell(3).value).toBe(125000.5)
    expect(r5.getCell(3).numFmt).toContain('$#,##0')
    expect(r5.getCell(5).numFmt).toContain('0.0%')
    expect(ws.getRow(6).getCell(5).value).toBeNull()
    // totals: SUM formulas for measures, blank for the ratio
    const total = ws.getRow(8)
    expect(total.getCell(1).value).toBe('Total')
    expect((total.getCell(3).value as { formula: string }).formula).toBe('SUM(C5:C7)')
    expect((total.getCell(4).value as { formula: string }).formula).toBe('SUM(D5:D7)')
    expect(total.getCell(5).value).toBeNull()
    // frozen header and autofilter
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 })
    expect(ws.autoFilter).toMatchObject({ from: { row: 4, column: 1 }, to: { row: 7, column: 5 } })
  })

  it('includes a "How calculated" sheet with definitions, concrete filter dates and the SQL', async () => {
    const wb = await buildWorkbook({ title: 'Billing by month', compiled, rows, generatedAt: NOW, link: 'http://localhost/#r=abc' })
    const ex = wb.getWorksheet('How calculated')!
    const texts: string[] = []
    ex.eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))))
    const all = texts.join('\n')
    expect(all).toContain(compiled.explanation.summary)
    expect(all).toContain('Total Billed')
    expect(all).toContain('Sum of invoice amounts, regardless of payment status.')
    expect(all).toContain('Invoice Date is in last quarter (2026-07-01 to 2026-10-01, exclusive)')
    expect(all).toContain('Data path: Invoices → Engagements')
    expect(all).toContain('http://localhost/#r=abc')
    expect(all).toContain(compiled.sql)
  })

  it('round-trips through the xlsx bytes', async () => {
    const buf = await buildExcelBuffer({ title: 'Round trip', compiled, rows, generatedAt: NOW })
    expect(buf.byteLength).toBeGreaterThan(5000)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Report', 'How calculated'])
    const ws = wb.getWorksheet('Report')!
    expect(ws.getRow(5).getCell(2).value).toBe('Tax')
    expect(ws.getRow(5).getCell(3).value).toBe(125000.5)
  })

  it('handles a comparison report: prior and change columns get totals, change % does not', async () => {
    const cmp = compile(
      practiceModel,
      {
        ...emptyQuery(),
        dimensions: ['clients.name'],
        measures: ['invoices.billed'],
        filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_quarter' }],
        compare: 'previous_period',
      },
      { now: NOW },
    )
    const cmpRows = [
      { d0: 'A', m0: 100, m0_prev: 80, m0_chg: 20, m0_pct: 0.25 },
      { d0: 'B', m0: 50, m0_prev: 100, m0_chg: -50, m0_pct: -0.5 },
    ]
    const wb = await buildWorkbook({ title: 'Compare', compiled: cmp, rows: cmpRows, generatedAt: NOW })
    const ws = wb.getWorksheet('Report')!
    expect(ws.getRow(4).getCell(3).value).toBe('Total Billed (prior)')
    const total = ws.getRow(7)
    expect((total.getCell(2).value as { formula: string }).formula).toBe('SUM(B5:B6)')
    expect((total.getCell(3).value as { formula: string }).formula).toBe('SUM(C5:C6)')
    expect((total.getCell(4).value as { formula: string }).formula).toBe('SUM(D5:D6)')
    expect(total.getCell(5).value).toBeNull()
    const ex = wb.getWorksheet('How calculated')!
    const texts: string[] = []
    ex.eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))))
    expect(texts.join('\n')).toContain('"Prior" columns use the same definitions')
  })
})
