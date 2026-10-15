import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { join } from 'node:path'
import { compile } from '../core/compiler'
import { practiceModel } from './practiceModel'
import { templates } from './templates'

const NOW = new Date('2026-10-13T12:00:00Z')
let conn: DuckDBConnection

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()
  for (const t of ['clients', 'staff', 'engagements', 'time_entries', 'invoices', 'payments']) {
    const p = join(process.cwd(), 'public', 'data', `${t}.csv`).replace(/\\/g, '/')
    await conn.run(`CREATE TABLE ${t} AS SELECT * FROM read_csv('${p}', header=true)`)
  }
})
afterAll(() => conn?.closeSync())

describe('templates', () => {
  it('have unique ids', () => {
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length)
  })

  for (const t of templates) {
    it(`"${t.name}" compiles, runs, and returns rows`, async () => {
      const compiled = compile(practiceModel, t.query, { now: NOW })
      const reader = await conn.runAndReadAll(compiled.sql)
      const rows = reader.getRowObjectsJson()
      expect(rows.length, `${t.name} returned no rows on the sample data`).toBeGreaterThan(0)
      // every requested field shows up as a column
      expect(compiled.columns.length).toBe(t.query.dimensions.length + t.query.measures.length)
      // sort field is in the report
      for (const s of t.query.sorts) expect(compiled.columns.some((c) => c.ref === s.field)).toBe(true)
    })
  }
})
