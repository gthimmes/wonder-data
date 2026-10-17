/**
 * End-to-end check in a real headless Chrome against the running dev server.
 * Catches what unit tests cannot: DuckDB-WASM engine differences, rendering,
 * and the builder's interaction flow.
 *
 *   pnpm dev            (in another terminal)
 *   pnpm check:browser  [--screens docs/screens]
 *
 * Needs Chrome or Edge installed; set BROWSER_PATH to override.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const screensIdx = process.argv.indexOf('--screens')
const SCREENS = screensIdx >= 0 ? process.argv[screensIdx + 1] : null
const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome/Edge found. Set BROWSER_PATH.')
  process.exit(2)
}
if (SCREENS) mkdirSync(SCREENS, { recursive: true })
const shot = (name) => (SCREENS ? page.screenshot({ path: `${SCREENS}/${name}.png` }) : Promise.resolve())

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))

// 1. Engine boots and every template runs in DuckDB-WASM (native DuckDB in vitest is not the same build).
const t0 = Date.now()
await page.goto(BASE + '/')
await page.waitForFunction(() => document.querySelector('.topbar .status')?.textContent?.includes('sample data'), null, { timeout: 90000 })
check(true, `engine ready in ${Date.now() - t0} ms`)
const templateResults = await page.evaluate(async () => {
  const { runSql } = await import('/src/core/runtime.ts')
  const { compile } = await import('/src/core/compiler.ts')
  const { practiceModel } = await import('/src/data/practiceModel.ts')
  const { templates } = await import('/src/data/templates.ts')
  const out = []
  for (const t of templates) {
    const sql = compile(practiceModel, t.query).sql
    const start = performance.now()
    try {
      const r = await runSql(sql)
      out.push({ id: t.id, ms: Math.round(performance.now() - start), rows: r.rowCount })
    } catch (e) {
      out.push({ id: t.id, error: String(e).split('\n')[0].slice(0, 200) })
    }
  }
  return out
})
for (const r of templateResults) check(!r.error && r.rows > 0, `template ${r.id}: ${r.error ?? `${r.rows} rows in ${r.ms} ms`}`)
await shot('templates')

// 2. Open a template, verify the table, totals and explanation.
await page.click('.card:has-text("Realization by Partner")')
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
const rows = await page.$$eval('table.grid tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)))
check(rows.length > 2 && rows[0][3]?.endsWith('%'), `realization by partner: ${rows.length} rows, first = ${JSON.stringify(rows[0])}`)
await page.waitForSelector('.chart-wrap svg', { timeout: 20000 })
await shot('builder')
await page.click('text=How is this calculated?')
await page.waitForSelector('.explain-measure')
const measures = await page.$$eval('.explain-measure b', (b) => b.map((x) => x.textContent))
check(measures.length === 3, `explain lists ${measures.length} measures: ${measures.join(', ')}`)
await shot('explain')

// 3. Fan-out refusal is surfaced in the field picker.
const staffBtn = await page.$('button.field:has-text("Staff Member")')
const reason = await staffBtn.getAttribute('title')
check((await staffBtn.isDisabled()) && /double-counted/.test(reason ?? ''), `unsafe field disabled with reason: ${reason?.slice(0, 80)}…`)

// 4. Time grain and chart type switch.
await page.click('button.field:has-text("Invoice Date")')
await page.waitForFunction(() => document.querySelectorAll('.pill.dim').length === 2)
await page.selectOption('.pill.dim select', 'quarter')
await page.click('.seg button:has-text("Line")')
await page.waitForSelector('.chart-wrap svg', { timeout: 20000 })
await page.waitForTimeout(500)
check((await page.textContent('.summary'))?.includes('(by quarter)'), 'quarter grain applied')
await shot('line')

// 5. Filter editor offers real values and applies.
await page.click('text=+ Add filter')
await page.selectOption('.popover select >> nth=0', { label: 'Clients › Client Tier' })
await page.waitForSelector('.popover input[type=checkbox]', { timeout: 10000 })
await page.click('.popover input[type=checkbox] >> nth=0')
await page.click('.popover button:has-text("Add filter")')
await page.waitForTimeout(800)
const filters = await page.$$eval('.pill.filter', (p) => p.map((x) => x.textContent))
check(filters.length === 2 && /Client Tier is one of/.test(filters[1]), `filters: ${filters.join(' | ')}`)
await shot('filter')

// 6. Save, then reopen from Saved.
await page.fill('.toolbar .title input', 'Check: realization trend')
await page.click('.toolbar button:has-text("Save")')
await page.waitForSelector('.toolbar button:has-text("Saved ✓")')
await page.click('nav button:has-text("Saved")')
await page.waitForSelector('.card b:has-text("Check: realization trend")')
await shot('saved')
await page.click('.card:has-text("Check: realization trend")')
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
check((await page.$$eval('.pill.filter', (p) => p.length)) === 2, 'saved report restores filters')

// 7. Switching templates never shows stale rows and AR aging works in WASM.
await page.click('nav button:has-text("Templates")')
await page.click('.card:has-text("AR Aging Summary")')
await page.waitForFunction(() => document.querySelector('.summary')?.textContent?.includes('Age Bucket'))
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
const ar = await page.$$eval('table.grid tbody tr td:first-child', (tds) => tds.map((td) => td.textContent))
check(ar.some((x) => /days|Current/.test(x ?? '')), `AR aging buckets: ${ar.join(', ')}`)
await shot('ar-aging')

// 8. Period comparison: template with compare, grouped headers, signed change cells, chart renders in WASM.
await page.click('nav button:has-text("Templates")')
await page.click('.card:has-text("Billing This Year vs Last Year")')
await page.waitForFunction(() => document.querySelector('.summary')?.textContent?.includes('same period last year'))
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
const groupHeads = await page.$$eval('table.grid th.group', (ths) => ths.map((t) => t.textContent))
const subHeads = await page.$$eval('table.grid th.sub', (ths) => ths.map((t) => t.textContent))
const toned = await page.$$eval('table.grid td.pos, table.grid td.neg', (tds) => tds.length)
const cmpRows = await page.$$eval('table.grid tbody tr:not(.total)', (trs) => trs.length)
check(groupHeads.join('|') === 'Total Billed|Number of Invoices' && subHeads.length === 8 && toned > 0 && cmpRows === 10, `compare: groups ${groupHeads.join(', ')}; ${subHeads.length} sub-headers; ${toned} signed cells; ${cmpRows} months`)
await page.waitForSelector('.chart-wrap svg', { timeout: 20000 })
const legend = await page.textContent('.chart-wrap svg')
check(/This period/.test(legend ?? '') && /Prior period/.test(legend ?? ''), 'compare chart shows this vs prior period series')
await page.waitForTimeout(300)
await shot('compare')

// 9. Compare select on an ordinary template, then switch it off again.
await page.click('nav button:has-text("Templates")')
await page.click('.card:has-text("Realization by Partner")')
await page.waitForFunction(() => document.querySelector('.summary')?.textContent?.includes('Realization %'))
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
check(!(await page.isDisabled('.shelf .compare select')), 'compare select enabled when a date filter exists')
await page.selectOption('.shelf .compare select', 'previous_period')
await page.waitForFunction(() => document.querySelector('.summary')?.textContent?.includes('previous period'))
await page.waitForSelector('table.grid th.group', { timeout: 30000 })
check((await page.$$eval('table.grid th.group', (t) => t.length)) === 3, 'three measure groups when comparing realization')
await page.selectOption('.shelf .compare select', '')
await page.waitForFunction(() => !document.querySelector('.summary')?.textContent?.includes('previous period'))
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
check((await page.$$eval('table.grid th.group', (t) => t.length)) === 0, 'compare switched off restores plain columns')

// 10. Drill to detail: click a row, records reconcile to the cell, switch measure tab, close.
await page.click('table.grid tbody tr:not(.total) >> nth=0')
await page.waitForSelector('.modal.detail', { timeout: 10000 })
await page.waitForSelector('.modal .reconcile', { timeout: 30000 })
const reconcile = await page.textContent('.modal .reconcile')
const detailTitle = await page.textContent('.modal-head h3')
check(/add up to/.test(reconcile ?? '') && (await page.$('.modal .reconcile.ok')) !== null, `drill: "${detailTitle}" — ${reconcile?.slice(0, 90)}`)
const conditions = await page.$$eval('.modal .conditions li', (li) => li.map((x) => x.textContent))
check(conditions.some((c) => /^Partner is "/.test(c ?? '')) && conditions.some((c) => /Invoice Date is in last 12 months/.test(c ?? '')), `drill conditions: ${conditions.join(' | ')}`)
await shot('drill')
await page.click('.modal-head .seg button:has-text("Total Billed")')
await page.waitForFunction(() => document.querySelector('.modal-head h3')?.textContent?.includes('Invoices behind Total Billed'))
await page.waitForSelector('.modal .reconcile.ok', { timeout: 30000 })
check(true, `drill: switched to ${await page.textContent('.modal-head h3')} — ${(await page.textContent('.modal .reconcile'))?.slice(0, 80)}`)
await page.keyboard.press('Escape')
await page.waitForSelector('.modal.detail', { state: 'detached' })
check(true, 'drill closes with Escape')

// 11. Excel export builds a workbook in the browser bundle (exceljs browser build + both sheets).
const buildXlsx = () => page.evaluate(async () => {
  const { buildExcelBuffer } = await import('/src/core/excel.ts')
  const { compile } = await import('/src/core/compiler.ts')
  const { practiceModel } = await import('/src/data/practiceModel.ts')
  const { runSql } = await import('/src/core/runtime.ts')
  const { templates } = await import('/src/data/templates.ts')
  const t = templates.find((x) => x.id === 'billing-vs-last-year')
  const compiled = compile(practiceModel, t.query)
  const result = await runSql(compiled.sql)
  const buf = await buildExcelBuffer({ title: t.name, compiled, rows: result.rows })
  return { bytes: buf.byteLength, rows: result.rowCount }
})
let xlsx
try {
  xlsx = await buildXlsx()
} catch (e) {
  // A cold dev server may discover a lazy dependency and reload the page once; the engine must boot again.
  if (!/Execution context was destroyed/.test(String(e))) throw e
  await page.waitForFunction(() => document.querySelector('.topbar .status')?.textContent?.includes('sample data'), null, { timeout: 90000 })
  xlsx = await buildXlsx()
}
check(xlsx.bytes > 5000, `excel export: ${xlsx.bytes} bytes for ${xlsx.rows} rows`)

// 12. (opt-in: --assistant) The assistant builds a report through the local Claude Code endpoint.
//    Opt-in because it calls a model: slower, nondeterministic, and it spends the developer's quota.
if (process.argv.includes('--assistant')) {
  const avail = await page.evaluate(() => fetch('/api/assistant').then((r) => r.json()).catch(() => ({ available: false })))
  check(avail.available, `assistant endpoint available (${avail.backend ?? 'none'})`)
  if (avail.available) {
    await page.click('.toolbar button:has-text("Ask")')
    await page.waitForSelector('.assistant textarea', { timeout: 10000 })
    await page.fill('.assistant textarea', 'Top 10 clients by unbilled WIP, with hours')
    await page.press('.assistant textarea', 'Enter')
    const t1 = Date.now()
    await page.waitForSelector('.assistant .answer .chips, .assistant .answer.q', { timeout: 150000 })
    const answer = await page.textContent('.assistant .answer >> nth=-1')
    const chips = await page.$$eval('.assistant .chips .pill', (p) => p.map((x) => x.textContent))
    const summary = await page.textContent('.summary')
    check(chips.includes('Client') && chips.includes('Unbilled WIP') && /Unbilled WIP/.test(summary ?? ''), `assistant built the report in ${Date.now() - t1} ms: ${chips.join(', ')} — "${answer?.slice(0, 120)}"`)
    await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
    const n = await page.$$eval('table.grid tbody tr:not(.total)', (r) => r.length)
    check(n === 10, `assistant applied limit 10 (${n} rows)`)
    await shot('assistant')
  }
}

check(errors.length === 0, `console errors: ${errors.length}${errors.length ? '\n' + errors.slice(0, 3).join('\n') : ''}`)
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
