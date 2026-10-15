/**
 * Generates a deterministic synthetic dataset for a professional-services firm
 * (clients, staff, engagements, time entries, invoices, payments) as CSV files
 * under public/data. Run with: pnpm gen:data
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Mulberry32: tiny seeded PRNG so the dataset is identical on every run.
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(20261013)
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
const round2 = (n: number) => Math.round(n * 100) / 100
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000)

const START = new Date(Date.UTC(2024, 0, 1))
const END = new Date(Date.UTC(2026, 9, 13)) // today
const DAYS = Math.round((END.getTime() - START.getTime()) / 86400000)

const industries = ['Manufacturing', 'Healthcare', 'Real Estate', 'Technology', 'Retail', 'Construction', 'Nonprofit', 'Professional Services', 'Hospitality', 'Agriculture']
const states = ['CA', 'TX', 'NY', 'FL', 'IL', 'WA', 'CO', 'GA', 'OH', 'AZ']
const serviceLines = ['Tax', 'Audit', 'Advisory', 'Bookkeeping', 'CAS']
const offices = ['Denver', 'Austin', 'Chicago']
const roles: { role: string; rate: number; count: number }[] = [
  { role: 'Partner', rate: 450, count: 6 },
  { role: 'Director', rate: 325, count: 6 },
  { role: 'Manager', rate: 250, count: 12 },
  { role: 'Senior', rate: 185, count: 18 },
  { role: 'Staff', rate: 135, count: 24 },
]
const firstNames = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Quinn', 'Reese', 'Skyler', 'Dakota', 'Emerson', 'Finley', 'Harper', 'Jamie', 'Kendall', 'Logan', 'Parker', 'Rowan', 'Sawyer', 'Blake']
const lastNames = ['Nguyen', 'Patel', 'Garcia', 'Kim', 'Okafor', 'Schmidt', 'Rossi', 'Haddad', 'Larsen', 'Moreau', 'Tanaka', 'Walsh', 'Ivanova', 'Mendes', 'Chen', 'Dubois', 'Novak', 'Reyes', 'Singh', 'Brooks']
const companyA = ['Summit', 'Blue Ridge', 'Harbor', 'Pioneer', 'Cedar', 'Granite', 'Northwind', 'Silverline', 'Evergreen', 'Lakeside', 'Redwood', 'Ironworks', 'Copper', 'Prairie', 'Beacon', 'Atlas', 'Meridian', 'Keystone', 'Horizon', 'Juniper']
const companyB = ['Holdings', 'Partners', 'Group', 'Industries', 'Clinic', 'Foods', 'Labs', 'Logistics', 'Builders', 'Dental', 'Hospitality', 'Ventures', 'Farms', 'Capital', 'Properties']

// ---- staff
interface Staff { id: number; name: string; role: string; office: string; rate: number; hired_on: string; active: boolean }
const staff: Staff[] = []
let sid = 1
for (const r of roles) {
  for (let i = 0; i < r.count; i++) {
    staff.push({
      id: sid++,
      name: `${pick(firstNames)} ${pick(lastNames)}`,
      role: r.role,
      office: pick(offices),
      rate: r.rate + int(-2, 2) * 5,
      hired_on: iso(addDays(START, -int(30, 3000))),
      active: rand() > 0.08,
    })
  }
}
const partners = staff.filter((s) => s.role === 'Partner')
const managers = staff.filter((s) => s.role === 'Manager' || s.role === 'Director')

// ---- clients
interface Client { id: number; name: string; industry: string; state: string; partner_id: number; manager_id: number; since: string; status: string; tier: string }
const clients: Client[] = []
const usedNames = new Set<string>()
for (let i = 1; i <= 180; i++) {
  let name = `${pick(companyA)} ${pick(companyB)}`
  while (usedNames.has(name)) name = `${pick(companyA)} ${pick(companyB)} ${pick(['LLC', 'Inc', 'Co'])}`
  usedNames.add(name)
  clients.push({
    id: i,
    name,
    industry: pick(industries),
    state: pick(states),
    partner_id: pick(partners).id,
    manager_id: pick(managers).id,
    since: iso(addDays(START, -int(0, 2500))),
    status: rand() > 0.1 ? 'Active' : 'Former',
    tier: pick(['A', 'A', 'B', 'B', 'B', 'C', 'C', 'C', 'C']),
  })
}

// ---- engagements
interface Engagement { id: number; client_id: number; name: string; service_line: string; fee_type: string; budget_hours: number; fixed_fee: number | ''; started_on: string; status: string; lead_id: number }
const engagements: Engagement[] = []
let eid = 1
for (const c of clients) {
  const n = c.tier === 'A' ? int(3, 5) : c.tier === 'B' ? int(2, 3) : int(1, 2)
  for (let k = 0; k < n; k++) {
    const sl = pick(serviceLines)
    const feeType = sl === 'Bookkeeping' || sl === 'CAS' ? 'Fixed' : rand() > 0.5 ? 'Fixed' : 'Hourly'
    const budget = sl === 'Audit' ? int(120, 600) : sl === 'Tax' ? int(20, 200) : int(30, 300)
    const started = addDays(START, int(-200, DAYS - 30))
    const fixedFee = feeType === 'Fixed' ? round2(budget * int(150, 260)) : ''
    engagements.push({
      id: eid++,
      client_id: c.id,
      name: `${sl} ${started.getUTCFullYear()}${sl === 'Tax' ? ' Return' : sl === 'Audit' ? ' Engagement' : ' Services'}`,
      service_line: sl,
      fee_type: feeType,
      budget_hours: budget,
      fixed_fee: fixedFee,
      started_on: iso(started),
      status: c.status === 'Former' ? 'Closed' : pick(['Active', 'Active', 'Active', 'Closed', 'On Hold']),
      lead_id: pick(managers).id,
    })
  }
}

// ---- time entries
interface TimeEntry { id: number; engagement_id: number; staff_id: number; entered_on: string; hours: number; rate: number; billable: boolean; task: string; invoice_id: number | '' }
const timeEntries: TimeEntry[] = []
const tasks = ['Planning', 'Fieldwork', 'Review', 'Client meeting', 'Preparation', 'Research', 'Admin', 'Reconciliation']
let tid = 1
const seasonal = (d: Date) => {
  const m = d.getUTCMonth()
  return m === 1 || m === 2 || m === 3 ? 1.6 : m === 9 ? 1.2 : m === 11 ? 0.7 : 1
}
for (const e of engagements) {
  const started = new Date(e.started_on + 'T00:00:00Z')
  const spanDays = Math.min(DAYS - Math.max(0, Math.round((started.getTime() - START.getTime()) / 86400000)), int(60, 400))
  const entries = Math.round(e.budget_hours / 4 * (0.6 + rand() * 0.9))
  const team = [staff[int(0, staff.length - 1)], staff[int(0, staff.length - 1)], staff[int(0, staff.length - 1)]]
  for (let i = 0; i < entries; i++) {
    const d = addDays(started, int(0, Math.max(1, spanDays)))
    if (d > END) continue
    const s = pick(team)
    const hrs = round2(Math.max(0.25, Math.min(10, (1 + rand() * 5) * seasonal(d))))
    timeEntries.push({
      id: tid++,
      engagement_id: e.id,
      staff_id: s.id,
      entered_on: iso(d),
      hours: hrs,
      rate: s.rate,
      billable: rand() > 0.12,
      task: pick(tasks),
      invoice_id: '',
    })
  }
}

// ---- invoices + payments
interface Invoice { id: number; client_id: number; engagement_id: number; number: string; issued_on: string; due_on: string; amount: number; status: string; sent_via: string }
interface Payment { id: number; invoice_id: number; paid_on: string; amount: number; method: string }
const invoices: Invoice[] = []
const payments: Payment[] = []
let iid = 1
let pid = 1
const byEng = new Map<number, TimeEntry[]>()
for (const t of timeEntries) {
  const arr = byEng.get(t.engagement_id) ?? []
  arr.push(t)
  byEng.set(t.engagement_id, arr)
}
for (const e of engagements) {
  const entries = (byEng.get(e.id) ?? []).sort((a, b) => a.entered_on.localeCompare(b.entered_on))
  // bill in monthly batches
  const months = new Map<string, TimeEntry[]>()
  for (const t of entries) {
    const k = t.entered_on.slice(0, 7)
    const arr = months.get(k) ?? []
    arr.push(t)
    months.set(k, arr)
  }
  for (const [month, ts] of months) {
    const lastDay = new Date(ts[ts.length - 1].entered_on + 'T00:00:00Z')
    const issued = addDays(lastDay, int(3, 25))
    if (issued > END) continue
    const billable = ts.filter((t) => t.billable)
    const standard = billable.reduce((s, t) => s + t.hours * t.rate, 0)
    // realization: fixed-fee work is billed at the fixed share; hourly gets a write-down sometimes
    let amount: number
    if (e.fee_type === 'Fixed') amount = round2((Number(e.fixed_fee) / Math.max(1, months.size)) * (0.9 + rand() * 0.2))
    else amount = round2(standard * (rand() < 0.3 ? 0.7 + rand() * 0.25 : 0.95 + rand() * 0.08))
    if (amount < 50) continue
    const inv: Invoice = {
      id: iid,
      client_id: e.client_id,
      engagement_id: e.id,
      number: `INV-${String(iid).padStart(5, '0')}`,
      issued_on: iso(issued),
      due_on: iso(addDays(issued, 30)),
      amount,
      status: 'Open',
      sent_via: pick(['Email', 'Email', 'Email', 'Portal', 'Mail']),
    }
    for (const t of ts) t.invoice_id = iid
    // payments
    const client = clients.find((c) => c.id === e.client_id)!
    const payProb = client.tier === 'A' ? 0.93 : client.tier === 'B' ? 0.85 : 0.72
    let paid = 0
    if (rand() < payProb) {
      const lag = client.tier === 'A' ? int(5, 40) : client.tier === 'B' ? int(10, 70) : int(15, 120)
      const paidOn = addDays(issued, lag)
      if (paidOn <= END) {
        const partial = rand() < 0.12
        const amt = partial ? round2(amount * (0.4 + rand() * 0.4)) : amount
        payments.push({ id: pid++, invoice_id: iid, paid_on: iso(paidOn), amount: amt, method: pick(['ACH', 'ACH', 'Card', 'Check', 'Wire']) })
        paid += amt
        if (partial && rand() < 0.6) {
          const second = addDays(paidOn, int(10, 60))
          if (second <= END) {
            payments.push({ id: pid++, invoice_id: iid, paid_on: iso(second), amount: round2(amount - amt), method: pick(['ACH', 'Card', 'Check']) })
            paid = amount
          }
        }
      }
    }
    inv.status = paid >= amount - 0.01 ? 'Paid' : paid > 0 ? 'Partial' : rand() < 0.03 ? 'Written Off' : 'Open'
    invoices.push(inv)
    iid++
  }
}
// unbilled WIP: leave some recent entries un-invoiced
for (const t of timeEntries) {
  if (t.entered_on > iso(addDays(END, -45)) && rand() < 0.6) t.invoice_id = ''
}

// ---- write
function csv<T extends object>(rows: T[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0]) as (keyof T)[]
  const esc = (v: unknown) => {
    if (v === null || v === undefined || v === '') return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n'
}
const out = join(process.cwd(), 'public', 'data')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'staff.csv'), csv(staff))
writeFileSync(join(out, 'clients.csv'), csv(clients))
writeFileSync(join(out, 'engagements.csv'), csv(engagements))
writeFileSync(join(out, 'time_entries.csv'), csv(timeEntries))
writeFileSync(join(out, 'invoices.csv'), csv(invoices))
writeFileSync(join(out, 'payments.csv'), csv(payments))
console.log({ staff: staff.length, clients: clients.length, engagements: engagements.length, timeEntries: timeEntries.length, invoices: invoices.length, payments: payments.length })
