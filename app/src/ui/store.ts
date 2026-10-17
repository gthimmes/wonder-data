import { create } from 'zustand'
import { compile, type CompiledQuery } from '../core/compiler'
import { emptyQuery, type ComparePeriod, type Filter, type QuerySpec, type Sort } from '../core/query'
import { getDb, runSql, type ResultSet } from '../core/runtime'
import { practiceModel } from '../data/practiceModel'
import { templates } from '../data/templates'
import type { ChartType } from './chartType'

export interface SavedReport {
  id: string
  name: string
  query: QuerySpec
  chart: ChartType | 'auto'
  savedAt: string
}

export type View = 'builder' | 'templates' | 'saved'

/** A cell the user wants to see the records behind. */
export interface Drill {
  row: Record<string, unknown>
  measureRef: string
}

interface State {
  model: typeof practiceModel
  view: View
  query: QuerySpec
  chart: ChartType | 'auto'
  compiled: CompiledQuery | null
  compileError: string | null
  result: ResultSet | null
  running: boolean
  runError: string | null
  dbReady: boolean
  dbError: string | null
  explainOpen: boolean
  assistantOpen: boolean
  drill: Drill | null
  currentReport: { id: string; name: string } | null
  saved: SavedReport[]

  setView: (v: View) => void
  setQuery: (q: QuerySpec | ((q: QuerySpec) => QuerySpec)) => void
  addDimension: (ref: string) => void
  removeDimension: (ref: string) => void
  replaceDimension: (oldRef: string, newRef: string) => void
  addMeasure: (ref: string) => void
  removeMeasure: (ref: string) => void
  addFilter: (f: Filter) => void
  updateFilter: (i: number, f: Filter) => void
  removeFilter: (i: number) => void
  setSort: (s: Sort | null) => void
  setLimit: (n: number) => void
  setCompare: (c: ComparePeriod | undefined) => void
  setChart: (c: ChartType | 'auto') => void
  toggleExplain: () => void
  toggleAssistant: () => void
  openDrill: (d: Drill) => void
  closeDrill: () => void
  /** Give the current (unsaved) report a name, e.g. from the assistant. */
  setDraftTitle: (name: string) => void
  clear: () => void
  loadTemplate: (id: string) => void
  loadSaved: (id: string) => void
  saveCurrent: (name: string) => void
  deleteSaved: (id: string) => void
  run: () => Promise<void>
  warmup: () => Promise<void>
}

const SAVED_KEY = 'wonder.savedReports.v1'

function loadSavedReports(): SavedReport[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    return raw ? (JSON.parse(raw) as SavedReport[]) : []
  } catch {
    return []
  }
}

function persistSaved(saved: SavedReport[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved))
  } catch {
    /* storage unavailable; saving is best-effort */
  }
}

/** Reports are shareable by URL: the intent lives in the hash, nothing else. */
function queryFromHash(): { query: QuerySpec; chart: ChartType | 'auto' } | null {
  try {
    const h = location.hash.replace(/^#/, '')
    if (!h.startsWith('r=')) return null
    const json = decodeURIComponent(atob(h.slice(2)))
    const parsed = JSON.parse(json)
    return { query: { ...emptyQuery(), ...parsed.query }, chart: parsed.chart ?? 'auto' }
  } catch {
    return null
  }
}

export function hashForReport(query: QuerySpec, chart: ChartType | 'auto'): string {
  return 'r=' + btoa(encodeURIComponent(JSON.stringify({ query, chart })))
}

let runSeq = 0

export const useStore = create<State>((set, get) => {
  const initial = queryFromHash()
  const recompile = (query: QuerySpec) => {
    try {
      const compiled = compile(get().model, query)
      set({ query, compiled, compileError: null, drill: null })
    } catch (e) {
      set({ query, compiled: null, compileError: (e as Error).message, result: null, drill: null })
    }
  }
  const update = (fn: (q: QuerySpec) => QuerySpec) => {
    recompile(fn(get().query))
    void get().run()
  }

  return {
    model: practiceModel,
    view: initial ? 'builder' : 'templates',
    query: initial?.query ?? emptyQuery(),
    chart: initial?.chart ?? 'auto',
    compiled: null,
    compileError: null,
    result: null,
    running: false,
    runError: null,
    dbReady: false,
    dbError: null,
    explainOpen: false,
    assistantOpen: false,
    drill: null,
    currentReport: null,
    saved: loadSavedReports(),

    setView: (view) => set({ view }),
    setQuery: (q) => update((prev) => (typeof q === 'function' ? q(prev) : q)),
    addDimension: (ref) => update((q) => (q.dimensions.includes(ref) ? q : { ...q, dimensions: [...q.dimensions, ref] })),
    removeDimension: (ref) =>
      update((q) => ({
        ...q,
        dimensions: q.dimensions.filter((d) => d !== ref),
        sorts: q.sorts.filter((s) => s.field !== ref),
      })),
    replaceDimension: (oldRef, newRef) =>
      update((q) => ({
        ...q,
        dimensions: q.dimensions.map((d) => (d === oldRef ? newRef : d)),
        sorts: q.sorts.map((s) => (s.field === oldRef ? { ...s, field: newRef } : s)),
      })),
    addMeasure: (ref) => update((q) => (q.measures.includes(ref) ? q : { ...q, measures: [...q.measures, ref] })),
    removeMeasure: (ref) =>
      update((q) => ({
        ...q,
        measures: q.measures.filter((m) => m !== ref),
        sorts: q.sorts.filter((s) => s.field !== ref),
        filters: q.filters.filter((f) => f.field !== ref),
      })),
    addFilter: (f) => update((q) => ({ ...q, filters: [...q.filters, f] })),
    updateFilter: (i, f) => update((q) => ({ ...q, filters: q.filters.map((x, j) => (j === i ? f : x)) })),
    removeFilter: (i) => update((q) => ({ ...q, filters: q.filters.filter((_, j) => j !== i) })),
    setSort: (s) => update((q) => ({ ...q, sorts: s ? [s] : [] })),
    setLimit: (n) => update((q) => ({ ...q, limit: n })),
    setCompare: (compare) =>
      update((q) => {
        const next = { ...q }
        if (compare) next.compare = compare
        else delete next.compare
        return next
      }),
    setChart: (chart) => set({ chart }),
    toggleExplain: () => set((s) => ({ explainOpen: !s.explainOpen, assistantOpen: s.explainOpen ? s.assistantOpen : false })),
    toggleAssistant: () => set((s) => ({ assistantOpen: !s.assistantOpen, explainOpen: s.assistantOpen ? s.explainOpen : false })),
    openDrill: (drill) => set({ drill }),
    closeDrill: () => set({ drill: null }),
    setDraftTitle: (name) => set({ currentReport: { id: `draft_${Date.now().toString(36)}`, name } }),
    clear: () => {
      set({ currentReport: null, chart: 'auto', result: null })
      recompile(emptyQuery())
    },
    loadTemplate: (id) => {
      const t = templates.find((x) => x.id === id)
      if (!t) return
      set({ currentReport: { id: t.id, name: t.name }, chart: t.chart, view: 'builder' })
      recompile(structuredClone(t.query))
      void get().run()
    },
    loadSaved: (id) => {
      const r = get().saved.find((x) => x.id === id)
      if (!r) return
      set({ currentReport: { id: r.id, name: r.name }, chart: r.chart, view: 'builder' })
      recompile(structuredClone(r.query))
      void get().run()
    },
    saveCurrent: (name) => {
      const { query, chart, saved, currentReport } = get()
      const existing = saved.find((s) => s.id === currentReport?.id)
      const report: SavedReport = {
        id: existing ? existing.id : `r_${Date.now().toString(36)}`,
        name,
        query: structuredClone(query),
        chart,
        savedAt: new Date().toISOString(),
      }
      const next = existing ? saved.map((s) => (s.id === report.id ? report : s)) : [report, ...saved]
      persistSaved(next)
      set({ saved: next, currentReport: { id: report.id, name: report.name } })
    },
    deleteSaved: (id) => {
      const next = get().saved.filter((s) => s.id !== id)
      persistSaved(next)
      set({ saved: next, currentReport: get().currentReport?.id === id ? null : get().currentReport })
    },
    run: async () => {
      const { compiled, dbReady } = get()
      if (!compiled || !dbReady) return
      const seq = ++runSeq
      set({ running: true, runError: null })
      try {
        const result = await runSql(compiled.sql)
        if (seq !== runSeq) return
        set({ result, running: false })
      } catch (e) {
        if (seq !== runSeq) return
        set({ running: false, runError: (e as Error).message })
      }
    },
    warmup: async () => {
      try {
        await getDb()
        set({ dbReady: true })
        recompile(get().query)
        void get().run()
      } catch (e) {
        set({ dbError: (e as Error).message })
      }
    },
  }
})
