import type { QuerySpec } from '../core/query'
import type { ChartType } from '../ui/chartType'

export interface ReportTemplate {
  id: string
  name: string
  description: string
  /** Who typically asks for this, to help users find it. */
  audience: string
  query: QuerySpec
  chart: ChartType
}

/**
 * The reports partners and practice managers are actually judged on (see
 * docs/RESEARCH.md §6). Every template is just a saved intent: open it, change
 * a grouping or a date range, and it is yours.
 */
export const templates: ReportTemplate[] = [
  {
    id: 'billing-vs-last-year',
    name: 'Billing This Year vs Last Year',
    description: 'Total billed by month, year to date, next to the same months last year with the change. The first question at every partner meeting.',
    audience: 'Managing partner',
    query: {
      dimensions: ['invoices.issued_on__month'],
      measures: ['invoices.billed', 'invoices.count'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'year_to_date' }],
      sorts: [],
      limit: 100,
      compare: 'previous_year',
    },
    chart: 'bar',
  },
  {
    id: 'realization-by-partner',
    name: 'Realization by Partner',
    description: 'What each partner billed versus the standard value of the time their clients consumed, last 12 months.',
    audience: 'Managing partner',
    query: {
      dimensions: ['partners.name'],
      measures: ['time_entries.standard_value', 'invoices.billed', 'realization'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'realization', dir: 'asc' }],
      limit: 100,
    },
    chart: 'bar',
  },
  {
    id: 'realization-trend',
    name: 'Realization Trend by Service Line',
    description: 'Realization % by quarter for each service line. Spot write-downs before year end.',
    audience: 'Managing partner',
    query: {
      dimensions: ['invoices.issued_on__quarter', 'engagements.service_line'],
      measures: ['realization'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'invoices.issued_on__quarter', dir: 'asc' }],
      limit: 500,
    },
    chart: 'line',
  },
  {
    id: 'utilization-by-staff',
    name: 'Utilization by Staff',
    description: 'Hours and billable hours per person this year, with their role and office.',
    audience: 'Practice manager',
    query: {
      dimensions: ['staff.name', 'staff.role', 'staff.office'],
      measures: ['time_entries.hours', 'time_entries.billable_hours', 'time_entries.standard_value'],
      filters: [{ field: 'time_entries.entered_on', op: 'relative_date', value: 'year_to_date' }],
      sorts: [{ field: 'time_entries.billable_hours', dir: 'desc' }],
      limit: 200,
    },
    chart: 'table',
  },
  {
    id: 'ar-aging',
    name: 'AR Aging by Client',
    description: 'Outstanding invoices by age bucket, oldest first. Drill by changing the grouping to Partner.',
    audience: 'Billing partner',
    query: {
      dimensions: ['invoices.age_bucket', 'clients.name'],
      measures: ['invoices.outstanding', 'invoices.count'],
      filters: [{ field: 'invoices.status', op: 'in', value: ['Open', 'Partial'] }],
      sorts: [{ field: 'invoices.outstanding', dir: 'desc' }],
      limit: 500,
    },
    chart: 'table',
  },
  {
    id: 'ar-aging-summary',
    name: 'AR Aging Summary',
    description: 'Total outstanding by age bucket. The one-glance view for the Monday meeting.',
    audience: 'Billing partner',
    query: {
      dimensions: ['invoices.age_bucket'],
      measures: ['invoices.outstanding', 'invoices.count'],
      filters: [{ field: 'invoices.status', op: 'in', value: ['Open', 'Partial'] }],
      sorts: [{ field: 'invoices.outstanding', dir: 'desc' }],
      limit: 20,
    },
    chart: 'bar',
  },
  {
    id: 'wip-by-client',
    name: 'Unbilled WIP by Client',
    description: 'Billable time not yet on an invoice, by client and partner. Bill it before it ages.',
    audience: 'Billing partner',
    query: {
      dimensions: ['clients.name', 'partners.name'],
      measures: ['time_entries.wip', 'time_entries.billable_hours'],
      filters: [
        { field: 'time_entries.is_billed', op: 'eq', value: 'Unbilled' },
        { field: 'time_entries.wip', op: 'gt', value: 0 },
      ],
      sorts: [{ field: 'time_entries.wip', dir: 'desc' }],
      limit: 100,
    },
    chart: 'table',
  },
  {
    id: 'billing-by-month',
    name: 'Billing and Collections by Month',
    description: 'Total billed each month over the last 12 months.',
    audience: 'Firm owner',
    query: {
      dimensions: ['invoices.issued_on__month'],
      measures: ['invoices.billed', 'invoices.count'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'invoices.issued_on__month', dir: 'asc' }],
      limit: 24,
    },
    chart: 'bar',
  },
  {
    id: 'collections-by-month',
    name: 'Cash Collected by Month',
    description: 'Payments received each month by payment method.',
    audience: 'Firm owner',
    query: {
      dimensions: ['payments.paid_on__month', 'payments.method'],
      measures: ['payments.collected'],
      filters: [{ field: 'payments.paid_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'payments.paid_on__month', dir: 'asc' }],
      limit: 200,
    },
    chart: 'bar',
  },
  {
    id: 'budget-vs-actual',
    name: 'Budget vs Actual by Engagement',
    description: 'Active engagements where recorded hours exceed the budget.',
    audience: 'Practice manager',
    query: {
      dimensions: ['clients.name', 'engagements.name', 'engagements.service_line'],
      measures: ['engagements.budget_hours', 'time_entries.hours', 'budget_variance_hours'],
      filters: [
        { field: 'engagements.status', op: 'eq', value: 'Active' },
        { field: 'budget_variance_hours', op: 'gt', value: 0 },
      ],
      sorts: [{ field: 'budget_variance_hours', dir: 'desc' }],
      limit: 100,
    },
    chart: 'table',
  },
  {
    id: 'client-profitability',
    name: 'Client Profitability',
    description: 'Standard value, billed, collected, and realized rate per client over the last 12 months.',
    audience: 'Firm owner',
    query: {
      dimensions: ['clients.name', 'clients.tier', 'clients.industry'],
      measures: ['time_entries.billable_hours', 'time_entries.standard_value', 'invoices.billed', 'payments.collected', 'realization', 'avg_rate_realized'],
      filters: [{ field: 'invoices.issued_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'invoices.billed', dir: 'desc' }],
      limit: 200,
    },
    chart: 'table',
  },
  {
    id: 'hours-by-service-line',
    name: 'Hours by Service Line and Month',
    description: 'Where the firm\'s time went each month, by service line. Shows busy season clearly.',
    audience: 'Practice manager',
    query: {
      dimensions: ['time_entries.entered_on__month', 'engagements.service_line'],
      measures: ['time_entries.hours'],
      filters: [{ field: 'time_entries.entered_on', op: 'relative_date', value: 'last_12_months' }],
      sorts: [{ field: 'time_entries.entered_on__month', dir: 'asc' }],
      limit: 500,
    },
    chart: 'bar',
  },
]
