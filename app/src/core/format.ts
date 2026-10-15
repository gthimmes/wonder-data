import type { ColumnMeta } from './compiler'

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const currencyCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
const hours = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDate(v: string, grain?: ColumnMeta['grain']): string {
  const [y, m, d] = v.split('-').map(Number)
  if (!y || !m) return v
  switch (grain) {
    case 'year':
      return String(y)
    case 'quarter':
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`
    case 'month':
      return `${MONTHS[m - 1]} ${y}`
    case 'week':
      return `Wk of ${MONTHS[m - 1]} ${d}, ${y}`
    default:
      return `${MONTHS[m - 1]} ${d}, ${y}`
  }
}

export function formatValue(v: unknown, col: ColumnMeta): string {
  if (v === null || v === undefined) return ''
  if (col.kind === 'dimension') {
    if (col.type === 'date') return formatDate(String(v), col.grain)
    if (col.type === 'boolean') return v ? 'Yes' : 'No'
    return String(v)
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  switch (col.format) {
    case 'currency':
      return Math.abs(n) < 1000 ? currencyCents.format(n) : currency.format(n)
    case 'percent':
      return percent.format(n)
    case 'integer':
      return integer.format(n)
    case 'hours':
      return hours.format(n)
    default:
      return number.format(n)
  }
}

/** Raw-ish value suitable for CSV: numbers unformatted, dates ISO. */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(columns: ColumnMeta[], rows: Record<string, unknown>[]): string {
  const head = columns.map((c) => csvValue(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => csvValue(r[c.key])).join(',')).join('\n')
  return head + '\n' + body + '\n'
}
