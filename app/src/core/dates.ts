import type { RelativeDate } from './query'

/** A half-open date range [start, end) expressed as ISO dates (YYYY-MM-DD). */
export interface DateRange {
  start: string
  end: string
}

const pad = (n: number) => String(n).padStart(2, '0')

export function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d))
}

function addDays(d: Date, n: number): Date {
  return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)
}

function startOfWeek(d: Date): Date {
  // ISO week: Monday first.
  const dow = (d.getUTCDay() + 6) % 7
  return addDays(d, -dow)
}

function startOfMonth(d: Date): Date {
  return utc(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function startOfQuarter(d: Date): Date {
  return utc(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)
}

function startOfYear(d: Date): Date {
  return utc(d.getUTCFullYear(), 0, 1)
}

function addMonths(d: Date, n: number): Date {
  return utc(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())
}

/**
 * Resolve a relative-date preset to a concrete range. `now` is treated as a
 * calendar date (time of day ignored). Ranges are half-open so that "this month"
 * and "last month" never overlap and timestamps at the end of a day are included.
 */
export function resolveRelativeDate(preset: RelativeDate, now: Date): DateRange {
  // "Today" is the viewer's local calendar day; arithmetic then happens in UTC so DST never shifts a boundary.
  const today = utc(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = addDays(today, 1)
  switch (preset) {
    case 'today':
      return { start: iso(today), end: iso(tomorrow) }
    case 'yesterday':
      return { start: iso(addDays(today, -1)), end: iso(today) }
    case 'this_week':
      return { start: iso(startOfWeek(today)), end: iso(addDays(startOfWeek(today), 7)) }
    case 'last_week': {
      const s = addDays(startOfWeek(today), -7)
      return { start: iso(s), end: iso(addDays(s, 7)) }
    }
    case 'this_month':
      return { start: iso(startOfMonth(today)), end: iso(addMonths(startOfMonth(today), 1)) }
    case 'last_month': {
      const s = addMonths(startOfMonth(today), -1)
      return { start: iso(s), end: iso(startOfMonth(today)) }
    }
    case 'this_quarter':
      return { start: iso(startOfQuarter(today)), end: iso(addMonths(startOfQuarter(today), 3)) }
    case 'last_quarter': {
      const s = addMonths(startOfQuarter(today), -3)
      return { start: iso(s), end: iso(startOfQuarter(today)) }
    }
    case 'this_year':
      return { start: iso(startOfYear(today)), end: iso(utc(today.getUTCFullYear() + 1, 0, 1)) }
    case 'last_year':
      return { start: iso(utc(today.getUTCFullYear() - 1, 0, 1)), end: iso(startOfYear(today)) }
    case 'last_7_days':
      return { start: iso(addDays(today, -6)), end: iso(tomorrow) }
    case 'last_30_days':
      return { start: iso(addDays(today, -29)), end: iso(tomorrow) }
    case 'last_90_days':
      return { start: iso(addDays(today, -89)), end: iso(tomorrow) }
    case 'last_12_months':
      return { start: iso(addMonths(startOfMonth(today), -11)), end: iso(tomorrow) }
    case 'month_to_date':
      return { start: iso(startOfMonth(today)), end: iso(tomorrow) }
    case 'quarter_to_date':
      return { start: iso(startOfQuarter(today)), end: iso(tomorrow) }
    case 'year_to_date':
      return { start: iso(startOfYear(today)), end: iso(tomorrow) }
  }
}

/** Shift a range back by its own length, for period-over-period comparison. */
export function previousPeriod(range: DateRange): DateRange {
  const s = new Date(range.start + 'T00:00:00Z')
  const e = new Date(range.end + 'T00:00:00Z')
  const days = Math.round((e.getTime() - s.getTime()) / 86400000)
  return { start: iso(addDays(s, -days)), end: iso(s) }
}

/** The same range one year earlier, for same-period-last-year comparison. */
export function previousYear(range: DateRange): DateRange {
  const shift = (d: string) => {
    const x = new Date(d + 'T00:00:00Z')
    return iso(utc(x.getUTCFullYear() - 1, x.getUTCMonth(), x.getUTCDate()))
  }
  return { start: shift(range.start), end: shift(range.end) }
}

/** Add days to an ISO date. */
export function addDaysIso(d: string, n: number): string {
  return iso(addDays(new Date(d + 'T00:00:00Z'), n))
}

/**
 * How far the comparison period must be moved forward to line up with the
 * current one, so "Oct 2025" lands on the "Oct 2026" row. Whole-month ranges
 * shift by months (so a 28-day February lines up with a 31-day March);
 * anything else shifts by days.
 */
export interface PeriodShift {
  unit: 'day' | 'month'
  n: number
}

export function shiftBetween(from: DateRange, to: DateRange): PeriodShift {
  const d = (s: string) => new Date(s + 'T00:00:00Z')
  const wholeMonths = [from.start, from.end, to.start, to.end].every((s) => d(s).getUTCDate() === 1)
  if (wholeMonths) {
    const a = d(from.start)
    const b = d(to.start)
    return { unit: 'month', n: (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) }
  }
  return { unit: 'day', n: Math.round((d(to.start).getTime() - d(from.start).getTime()) / 86400000) }
}
