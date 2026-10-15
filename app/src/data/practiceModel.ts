import type { SemanticModel } from '../core/model'

/**
 * Semantic model for a professional-services firm (the sample dataset in
 * public/data). This is the kind of file a vendor or an admin maintains; end
 * users only ever see the labels and descriptions.
 */
export const practiceModel: SemanticModel = {
  name: 'Firm Practice Data',
  tables: [
    {
      name: 'clients',
      label: 'Clients',
      sql: 'clients',
      primaryKey: 'id',
      description: 'One row per client the firm serves.',
      dimensions: [
        { name: 'name', label: 'Client', type: 'string', description: 'Client name.' },
        { name: 'industry', label: 'Industry', type: 'string' },
        { name: 'state', label: 'State', type: 'string' },
        { name: 'tier', label: 'Client Tier', type: 'string', description: 'A = largest relationships, C = smallest.' },
        { name: 'status', label: 'Client Status', type: 'string', description: 'Active or Former.' },
        { name: 'since', label: 'Client Since', type: 'date' },
      ],
      measures: [
        { name: 'count', label: 'Number of Clients', agg: 'count_distinct', sql: '{t}."id"', format: 'integer' },
      ],
    },
    {
      name: 'staff',
      label: 'Staff',
      sql: 'staff',
      primaryKey: 'id',
      description: 'Everyone who records time.',
      dimensions: [
        { name: 'name', label: 'Staff Member', type: 'string' },
        { name: 'role', label: 'Role', type: 'string', description: 'Partner, Director, Manager, Senior or Staff.' },
        { name: 'office', label: 'Office', type: 'string' },
        { name: 'hired_on', label: 'Hire Date', type: 'date' },
        { name: 'active', label: 'Active Staff', type: 'boolean' },
      ],
      measures: [
        { name: 'count', label: 'Headcount', agg: 'count_distinct', sql: '{t}."id"', format: 'integer' },
        { name: 'avg_rate', label: 'Average Standard Rate', agg: 'avg', sql: '{t}."rate"', format: 'currency' },
      ],
    },
    {
      name: 'partners',
      label: 'Client Partner',
      sql: 'staff',
      primaryKey: 'id',
      description: 'The partner responsible for a client relationship.',
      dimensions: [
        { name: 'name', label: 'Partner', type: 'string', description: 'Partner responsible for the client.' },
        { name: 'office', label: 'Partner Office', type: 'string' },
      ],
      measures: [],
    },
    {
      name: 'engagements',
      label: 'Engagements',
      sql: 'engagements',
      primaryKey: 'id',
      description: 'A piece of work for a client, e.g. the 2025 tax return.',
      dimensions: [
        { name: 'name', label: 'Engagement', type: 'string' },
        { name: 'service_line', label: 'Service Line', type: 'string', description: 'Tax, Audit, Advisory, Bookkeeping or CAS.' },
        { name: 'fee_type', label: 'Fee Type', type: 'string', description: 'Fixed fee or Hourly.' },
        { name: 'status', label: 'Engagement Status', type: 'string' },
        { name: 'started_on', label: 'Engagement Start', type: 'date' },
      ],
      measures: [
        { name: 'count', label: 'Number of Engagements', agg: 'count_distinct', sql: '{t}."id"', format: 'integer' },
        { name: 'budget_hours', label: 'Budgeted Hours', agg: 'sum', format: 'hours', description: 'Total hours budgeted across engagements.' },
        { name: 'fixed_fees', label: 'Fixed Fees', agg: 'sum', sql: '{t}."fixed_fee"', format: 'currency', description: 'Sum of agreed fixed fees (hourly engagements contribute nothing).' },
      ],
    },
    {
      name: 'time_entries',
      label: 'Time',
      sql: 'time_entries',
      primaryKey: 'id',
      description: 'Hours recorded by staff against engagements.',
      dimensions: [
        { name: 'entered_on', label: 'Work Date', type: 'date' },
        { name: 'task', label: 'Task', type: 'string' },
        { name: 'billable', label: 'Billable', type: 'boolean' },
        { name: 'is_billed', label: 'Billed Status', type: 'string', sql: `CASE WHEN {t}."invoice_id" IS NULL THEN 'Unbilled' ELSE 'Billed' END`, description: 'Whether the time has been put on an invoice yet.' },
      ],
      measures: [
        { name: 'hours', label: 'Hours', agg: 'sum', format: 'hours', description: 'All hours recorded, billable or not.' },
        { name: 'billable_hours', label: 'Billable Hours', agg: 'sum', sql: '{t}."hours"', format: 'hours', filters: [{ dimension: 'billable', op: 'eq', value: true }], description: 'Hours flagged billable.' },
        { name: 'standard_value', label: 'Standard Value', agg: 'sum', sql: '{t}."hours" * {t}."rate"', format: 'currency', filters: [{ dimension: 'billable', op: 'eq', value: true }], description: 'Billable hours × the standard rate at the time. What the work was worth before any write-down.' },
        { name: 'wip', label: 'Unbilled WIP', agg: 'sum', sql: 'CASE WHEN {t}."invoice_id" IS NULL AND {t}."billable" THEN {t}."hours" * {t}."rate" ELSE 0 END', format: 'currency', description: 'Standard value of billable time not yet on an invoice.' },
        { name: 'entries', label: 'Time Entries', agg: 'count', format: 'integer' },
      ],
    },
    {
      name: 'invoices',
      label: 'Invoices',
      sql: 'invoices',
      primaryKey: 'id',
      description: 'Bills sent to clients.',
      dimensions: [
        { name: 'number', label: 'Invoice Number', type: 'string' },
        { name: 'issued_on', label: 'Invoice Date', type: 'date' },
        { name: 'due_on', label: 'Due Date', type: 'date' },
        { name: 'status', label: 'Invoice Status', type: 'string', description: 'Open, Partial, Paid or Written Off.' },
        { name: 'sent_via', label: 'Sent Via', type: 'string' },
        // date_diff rather than DATE - DATE: the WASM build of DuckDB lacks the date subtraction operator.
        { name: 'age_bucket', label: 'Age Bucket', type: 'string', sql: `CASE WHEN {t}."status" IN ('Paid','Written Off') THEN 'Settled' WHEN date_diff('day', CAST({t}."due_on" AS DATE), CURRENT_DATE) <= 0 THEN 'Current' WHEN date_diff('day', CAST({t}."due_on" AS DATE), CURRENT_DATE) <= 30 THEN '1-30 days' WHEN date_diff('day', CAST({t}."due_on" AS DATE), CURRENT_DATE) <= 60 THEN '31-60 days' WHEN date_diff('day', CAST({t}."due_on" AS DATE), CURRENT_DATE) <= 90 THEN '61-90 days' ELSE '90+ days' END`, description: 'How far past due an unpaid invoice is, as of today.' },
      ],
      measures: [
        { name: 'count', label: 'Number of Invoices', agg: 'count', format: 'integer' },
        { name: 'billed', label: 'Total Billed', agg: 'sum', sql: '{t}."amount"', format: 'currency', description: 'Sum of invoice amounts, regardless of payment status.' },
        { name: 'outstanding', label: 'Outstanding AR', agg: 'sum', sql: '{t}."amount"', format: 'currency', filters: [{ dimension: 'status', op: 'in', value: ['Open', 'Partial'] }], description: 'Invoice amounts still Open or Partial. Does not subtract partial payments; see Collected.' },
        { name: 'written_off', label: 'Written Off', agg: 'sum', sql: '{t}."amount"', format: 'currency', filters: [{ dimension: 'status', op: 'eq', value: 'Written Off' }] },
        { name: 'avg_invoice', label: 'Average Invoice', agg: 'avg', sql: '{t}."amount"', format: 'currency' },
      ],
    },
    {
      name: 'payments',
      label: 'Payments',
      sql: 'payments',
      primaryKey: 'id',
      description: 'Cash received against invoices.',
      dimensions: [
        { name: 'paid_on', label: 'Payment Date', type: 'date' },
        { name: 'method', label: 'Payment Method', type: 'string' },
      ],
      measures: [
        { name: 'collected', label: 'Collected', agg: 'sum', sql: '{t}."amount"', format: 'currency', description: 'Cash received.' },
        { name: 'count', label: 'Number of Payments', agg: 'count', format: 'integer' },
      ],
    },
  ],
  relationships: [
    { from: 'engagements', to: 'clients', cardinality: 'many_to_one', on: '{from}."client_id" = {to}."id"' },
    { from: 'clients', to: 'partners', cardinality: 'many_to_one', on: '{from}."partner_id" = {to}."id"' },
    { from: 'time_entries', to: 'engagements', cardinality: 'many_to_one', on: '{from}."engagement_id" = {to}."id"' },
    { from: 'time_entries', to: 'staff', cardinality: 'many_to_one', on: '{from}."staff_id" = {to}."id"' },
    { from: 'time_entries', to: 'invoices', cardinality: 'many_to_one', on: '{from}."invoice_id" = {to}."id"' },
    { from: 'invoices', to: 'engagements', cardinality: 'many_to_one', on: '{from}."engagement_id" = {to}."id"' },
    { from: 'invoices', to: 'clients', cardinality: 'many_to_one', on: '{from}."client_id" = {to}."id"' },
    { from: 'payments', to: 'invoices', cardinality: 'many_to_one', on: '{from}."invoice_id" = {to}."id"' },
  ],
  metrics: [
    {
      name: 'realization',
      label: 'Realization %',
      expr: '{invoices.billed} / {time_entries.standard_value}',
      format: 'percent',
      description: 'Total Billed divided by Standard Value of billable time. Below 100% means work was written down.',
    },
    {
      name: 'collection_rate',
      label: 'Collection %',
      expr: '{payments.collected} / {invoices.billed}',
      format: 'percent',
      description: 'Cash collected divided by total billed.',
    },
    {
      name: 'avg_rate_realized',
      label: 'Realized Rate',
      expr: '{invoices.billed} / {time_entries.billable_hours}',
      format: 'currency',
      description: 'Total Billed divided by Billable Hours: the effective hourly rate actually billed.',
    },
    {
      name: 'budget_variance_hours',
      label: 'Hours vs Budget',
      expr: '{time_entries.hours} - {engagements.budget_hours}',
      format: 'hours',
      description: 'Hours recorded minus hours budgeted. Positive means over budget.',
    },
  ],
}
