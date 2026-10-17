import type { CompiledQuery, ColumnMeta } from './compiler'
import { formatDate } from './format'

/**
 * Excel export that carries its own explanation. Sheet 1 is the report with
 * real number formats, real dates, a frozen header, filters and live SUM
 * totals. Sheet 2 is "How this was calculated": the same definitions, join
 * paths, concrete filter ranges and SQL the explain panel shows, so a number
 * forwarded in a spreadsheet still explains itself.
 */

export interface ExcelInput {
  title: string
  compiled: CompiledQuery
  rows: Record<string, unknown>[]
  /** When the export was generated; defaults to now. */
  generatedAt?: Date
  /** Where the report can be reopened, if known. */
  link?: string
}

type Workbook = import('exceljs').Workbook

export function numberFormat(col: ColumnMeta): string {
  switch (col.format) {
    case 'currency':
      return '$#,##0;[Red]-$#,##0'
    case 'percent':
      return '0.0%;[Red]-0.0%'
    case 'integer':
      return '#,##0'
    case 'hours':
      return '#,##0.0'
    default:
      return '#,##0.00'
  }
}

function dateFormat(col: ColumnMeta): string {
  switch (col.grain) {
    case 'year':
      return 'yyyy'
    case 'month':
      return 'mmm yyyy'
    default:
      return 'mmm d, yyyy'
  }
}

/** Convert a result value into what the cell should hold. */
export function cellValue(v: unknown, col: ColumnMeta): unknown {
  if (v === null || v === undefined) return null
  if (col.kind === 'dimension') {
    if (col.type === 'date') {
      // Quarters have no Excel number format; write the label. Everything else is a real date.
      if (col.grain === 'quarter') return formatDate(String(v), 'quarter')
      const [y, m, d] = String(v).slice(0, 10).split('-').map(Number)
      return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : String(v)
    }
    if (col.type === 'boolean') return v ? 'Yes' : 'No'
    return typeof v === 'number' ? v : String(v)
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const HEADER_ROW = 4

export async function buildWorkbook(input: ExcelInput): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Wonder Reports'
  wb.created = input.generatedAt ?? new Date()
  const { compiled, rows } = input
  const cols = compiled.columns

  // --- Sheet 1: the report
  const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: HEADER_ROW }] })
  ws.getCell('A1').value = input.title
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = compiled.explanation.summary
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF6B6B6B' } }

  const header = ws.getRow(HEADER_ROW)
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1)
    cell.value = c.label
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F0' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
    cell.alignment = { horizontal: c.kind === 'dimension' ? 'left' : 'right' }
  })

  for (const r of rows) {
    const row = ws.addRow(cols.map((c) => cellValue(r[c.key], c)))
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1)
      if (c.kind !== 'dimension') cell.numFmt = numberFormat(c)
      else if (c.type === 'date' && c.grain !== 'quarter') cell.numFmt = dateFormat(c)
    })
  }

  // Totals row with live SUM formulas for additive columns only.
  const firstData = HEADER_ROW + 1
  const lastData = HEADER_ROW + rows.length
  const hasDims = cols.some((c) => c.kind === 'dimension')
  if (rows.length > 1 && hasDims) {
    const total = ws.getRow(lastData + 1)
    cols.forEach((c, i) => {
      const cell = total.getCell(i + 1)
      if (i === 0) cell.value = 'Total'
      else if (c.kind === 'measure' && (c.role === undefined || c.role === 'previous' || c.role === 'change')) {
        const letter = ws.getColumn(i + 1).letter
        cell.value = { formula: `SUM(${letter}${firstData}:${letter}${lastData})` }
        cell.numFmt = numberFormat(c)
      }
      cell.font = { bold: true }
      cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
    })
  }

  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: cols.length } }
  cols.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length))
    ws.getColumn(i + 1).width = Math.min(48, Math.max(10, longest + 2))
  })

  // --- Sheet 2: how this was calculated
  const ex = wb.addWorksheet('How calculated')
  ex.getColumn(1).width = 28
  ex.getColumn(2).width = 90
  ex.getColumn(2).alignment = { wrapText: true, vertical: 'top' }
  let r = 1
  const put = (a: string, b?: string, opts?: { bold?: boolean; size?: number }) => {
    ex.getCell(r, 1).value = a
    if (b !== undefined) ex.getCell(r, 2).value = b
    if (opts?.bold) ex.getCell(r, 1).font = { bold: true, size: opts.size }
    r++
  }
  put('How this was calculated', undefined, { bold: true, size: 14 })
  put(input.title)
  r++
  put('In one sentence', compiled.explanation.summary, { bold: true })
  r++
  put('Each number', undefined, { bold: true })
  if (!compiled.explanation.measures.length) put('(none)', 'This report lists distinct values.')
  for (const m of compiled.explanation.measures) put(m.label, `${m.definition}\nData path: ${m.path}`)
  r++
  put('Filters', undefined, { bold: true })
  if (!compiled.explanation.filters.length) put('(none)', 'Every record is included.')
  for (const f of compiled.explanation.filters) put('', f)
  if (compiled.explanation.compare) {
    r++
    put('Comparison', compiled.explanation.compare.description, { bold: true })
  }
  r++
  put('Guarantees', undefined, { bold: true })
  put('', 'Each total is added up inside its own table before tables are combined, so joins can never double count.')
  put('', 'Ratios divide the totals, never average the rows. The Total row on the Report sheet is left blank for ratios for the same reason.')
  put('', 'Relative dates are fixed to the exact ranges listed above at the moment the report ran.')
  r++
  put('Generated', (input.generatedAt ?? new Date()).toISOString(), { bold: true })
  if (input.link) put('Reopen', input.link, { bold: true })
  r++
  put('SQL', compiled.sql, { bold: true })
  ex.getCell(r - 1, 2).font = { name: 'Consolas', size: 9 }

  return wb
}

/** Build and return the file bytes (for download in the browser or a test in Node). */
export async function buildExcelBuffer(input: ExcelInput): Promise<ArrayBuffer> {
  const wb = await buildWorkbook(input)
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
