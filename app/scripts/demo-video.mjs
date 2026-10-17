/**
 * Records a narrated (captioned) product demo as a video by driving the real
 * app in headless Chrome, with a visible cursor and on-screen captions.
 *
 *   pnpm dev                       (in another terminal)
 *   node scripts/demo-video.mjs    [--out ../docs/demo]
 *
 * Output: <out>/wonder-demo.webm
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : '../docs/demo'
mkdirSync(OUT, { recursive: true })

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome/Edge found. Set BROWSER_PATH.')
  process.exit(2)
}

const W = 1440
const H = 900
const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  acceptDownloads: true,
})
const page = await context.newPage()

// A visible cursor and a caption bar, injected before the app loads.
await page.addInitScript(() => {
  const style = document.createElement('style')
  style.textContent = `
    #demo-cursor { position: fixed; z-index: 99999; width: 18px; height: 18px; margin: -4px 0 0 -4px; pointer-events: none;
      border-radius: 50%; background: rgba(42,120,214,0.35); border: 2px solid #2a78d6; transition: transform 80ms; }
    #demo-cursor.down { transform: scale(0.6); background: rgba(42,120,214,0.8); }
    #demo-caption { position: fixed; z-index: 99998; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%;
      background: rgba(20,22,26,0.88); color: #fff; font: 500 20px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      padding: 12px 20px; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); opacity: 0; transition: opacity 250ms; pointer-events: none; text-align: center; }
    #demo-caption.show { opacity: 1; }
    #demo-caption small { display: block; font-weight: 400; font-size: 15px; opacity: 0.8; margin-top: 4px; }
  `
  document.addEventListener('DOMContentLoaded', () => {
    document.head.appendChild(style)
    const c = document.createElement('div')
    c.id = 'demo-cursor'
    document.body.appendChild(c)
    const cap = document.createElement('div')
    cap.id = 'demo-caption'
    document.body.appendChild(cap)
    window.addEventListener('mousemove', (e) => {
      c.style.left = e.clientX + 'px'
      c.style.top = e.clientY + 'px'
    })
    window.addEventListener('mousedown', () => c.classList.add('down'))
    window.addEventListener('mouseup', () => setTimeout(() => c.classList.remove('down'), 120))
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const caption = async (text, sub) => {
  await page.evaluate(
    ([t, s]) => {
      const el = document.getElementById('demo-caption')
      el.innerHTML = t + (s ? `<small>${s}</small>` : '')
      el.classList.add('show')
    },
    [text, sub ?? ''],
  )
}
const clearCaption = () => page.evaluate(() => document.getElementById('demo-caption')?.classList.remove('show'))

/** Move the cursor to an element smoothly, then click it. */
async function click(selector, opts = {}) {
  const el = page.locator(selector).first()
  await el.waitFor({ state: 'visible', timeout: 30000 })
  const box = await el.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
  await sleep(250)
  await el.click(opts)
}

// --- the story ------------------------------------------------------------
await page.goto(BASE + '/')
await page.mouse.move(W / 2, H / 2)
await page.waitForFunction(() => document.querySelector('.topbar .status')?.textContent?.includes('sample data'), null, { timeout: 90000 })
await caption('Wonder: report building people can trust', 'Everything here runs on a synthetic accounting firm dataset, in the browser')
await sleep(3200)

await caption('Start from a template, not a blank canvas', 'The reports partners are judged on, grouped by who asks for them')
await sleep(2200)
await click('.card:has-text("Realization by Partner")')
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
await page.waitForSelector('.chart-wrap svg', { timeout: 20000 })
await sleep(2600)

await caption('Every number explains itself', 'Definitions, join paths and concrete date ranges, in plain language')
await click('text=How is this calculated?')
await page.waitForSelector('.explain-measure')
await sleep(4200)
await click('.rightpanel .btn:has-text("Close")')

await caption('Fields that would double count are greyed out, with the reason', 'The compiler refuses fan-out joins instead of silently inflating totals')
const staff = page.locator('button.field:has-text("Staff Member")').first()
const sb = await staff.boundingBox()
if (sb) await page.mouse.move(sb.x + 40, sb.y + sb.height / 2, { steps: 20 })
await sleep(3400)

await caption('Compare with the same period last year', 'The same definitions run over the shifted range; months line up row by row')
await click('.shelf .compare select')
await page.selectOption('.shelf .compare select', 'previous_year')
await page.waitForSelector('table.grid th.group', { timeout: 30000 })
await sleep(1200)
await click('.seg button:has-text("Table")')
await sleep(3600)
await click('.seg button:has-text("Bar")')
await page.waitForSelector('.chart-wrap svg', { timeout: 20000 })
await sleep(2800)
await page.selectOption('.shelf .compare select', '')
await page.waitForFunction(() => !document.querySelector('table.grid th.group'))

await caption('Click any row to see the records behind the number', 'They add up to the cell, and every selecting condition is spelled out')
await click('table.grid tbody tr:not(.total) >> nth=0')
await page.waitForSelector('.modal .reconcile.ok', { timeout: 30000 })
await sleep(3800)
await click('.modal-head .seg button:has-text("Total Billed")')
await page.waitForFunction(() => document.querySelector('.modal-head h3')?.textContent?.includes('Total Billed'))
await page.waitForSelector('.modal .reconcile.ok', { timeout: 30000 })
await sleep(2600)
await click('.modal-head .btn:has-text("Close")')

await caption('Or just ask', 'Claude proposes fields from the governed model; the same compiler validates them. It never writes SQL.')
await click('.toolbar button:has-text("Ask")')
await page.waitForSelector('.assistant textarea', { timeout: 10000 })
await page.waitForFunction(() => !document.querySelector('.assistant .body')?.textContent?.includes('Connecting'))
await click('.assistant textarea')
await page.type('.assistant textarea', 'Which clients have the most unbilled WIP? Show hours too, top 10', { delay: 38 })
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForSelector('.assistant .answer .chips, .assistant .answer.q', { timeout: 150000 })
await page.waitForSelector('table.grid tbody tr', { timeout: 30000 })
await sleep(4200)

await caption('Export to Excel with the explanation attached', 'Real formats, live totals, and a “How calculated” sheet for whoever gets the file')
const dl = page.waitForEvent('download', { timeout: 60000 })
await click('.toolbar button:has-text("Export Excel")')
const file = await dl
await file.saveAs(join(OUT, 'wonder-demo-export.xlsx'))
await sleep(2400)

await caption('Wonder', 'Semantic model + deterministic compiler. Cannot double count. Every number explains itself.')
await sleep(3200)
await clearCaption()
await sleep(600)

await context.close()
await browser.close()

// Playwright names the file by a random id; give it a stable name.
const webm = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f !== 'wonder-demo.webm')
if (webm.length) renameSync(join(OUT, webm[webm.length - 1]), join(OUT, 'wonder-demo.webm'))
console.log('video:', join(OUT, 'wonder-demo.webm'))
