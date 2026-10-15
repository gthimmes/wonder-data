import * as duckdb from '@duckdb/duckdb-wasm'

/**
 * In-browser execution: DuckDB-WASM loaded once, sample tables registered from
 * CSV files served under /data. Every builder change becomes a local query.
 */

export interface ResultSet {
  /** The SQL that produced these rows, so the UI never renders rows against a different query's columns. */
  sql: string
  rows: Record<string, unknown>[]
  rowCount: number
  elapsedMs: number
}

const TABLES = ['clients', 'staff', 'engagements', 'time_entries', 'invoices', 'payments']

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null

async function init(): Promise<duckdb.AsyncDuckDB> {
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const logger = new duckdb.VoidLogger()
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)

  const conn = await db.connect()
  const base = `${location.origin}${import.meta.env.BASE_URL}data/`
  for (const t of TABLES) {
    const res = await fetch(`${base}${t}.csv`)
    if (!res.ok) throw new Error(`Could not load sample data: ${t}.csv (${res.status})`)
    const text = await res.text()
    await db.registerFileText(`${t}.csv`, text)
    await conn.query(`CREATE TABLE ${t} AS SELECT * FROM read_csv('${t}.csv', header=true)`)
  }
  await conn.close()
  return db
}

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = init().catch((e) => { dbPromise = null; throw e })
  return dbPromise
}

function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  // Arrow Date32 columns come back as epoch-ms numbers only through getChild; row objects give Date or number.
  return v
}

export async function runSql(sql: string): Promise<ResultSet> {
  const db = await getDb()
  const conn = await db.connect()
  const start = performance.now()
  try {
    const table = await conn.query(sql)
    const fields = table.schema.fields
    const rows: Record<string, unknown>[] = []
    for (const r of table) {
      const o: Record<string, unknown> = {}
      for (const f of fields) {
        let v = r[f.name]
        // DuckDB-WASM returns DATE as epoch milliseconds for Date32/64 when read via row proxy.
        if (typeof v === 'number' && /^Date/.test(f.type.toString())) v = new Date(v)
        o[f.name] = cell(v)
      }
      rows.push(o)
    }
    return { sql, rows, rowCount: rows.length, elapsedMs: performance.now() - start }
  } finally {
    await conn.close()
  }
}

/** Distinct values of a dimension expression, for filter pickers. */
export async function distinctValues(sql: string, limit = 200): Promise<unknown[]> {
  const res = await runSql(`SELECT DISTINCT v FROM (${sql}) ORDER BY v NULLS LAST LIMIT ${limit}`)
  return res.rows.map((r) => r.v)
}
