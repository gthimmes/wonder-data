import { useState } from 'react'
import { toCsv } from '../core/format'
import { Assistant } from './Assistant'
import { CHART_TYPES } from './chartType'
import { ExplainPanel } from './ExplainPanel'
import { FieldPicker } from './FieldPicker'
import { ResultView } from './ResultView'
import { Shelves } from './Shelves'
import { hashForReport, useStore } from './store'

function Toolbar() {
  const currentReport = useStore((s) => s.currentReport)
  const query = useStore((s) => s.query)
  const chart = useStore((s) => s.chart)
  const setChart = useStore((s) => s.setChart)
  const compiled = useStore((s) => s.compiled)
  const result = useStore((s) => s.result)
  const explainOpen = useStore((s) => s.explainOpen)
  const toggleExplain = useStore((s) => s.toggleExplain)
  const assistantOpen = useStore((s) => s.assistantOpen)
  const toggleAssistant = useStore((s) => s.toggleAssistant)
  const saveCurrent = useStore((s) => s.saveCurrent)
  const setLimit = useStore((s) => s.setLimit)
  const clear = useStore((s) => s.clear)
  const [name, setName] = useState(currentReport?.name ?? '')
  const [copied, setCopied] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  // Keep the editable title in sync when a different report is loaded.
  const [lastId, setLastId] = useState(currentReport?.id)
  if (currentReport?.id !== lastId) {
    setLastId(currentReport?.id)
    setName(currentReport?.name ?? '')
  }

  const exportCsv = () => {
    if (!compiled || !result) return
    const csv = toCsv(compiled.columns, result.rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name || 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const share = async () => {
    const url = `${location.origin}${location.pathname}#${hashForReport(query, chart)}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      prompt('Copy this link', url)
    }
  }

  return (
    <div className="toolbar">
      <span className="title">
        <input placeholder="Untitled report" value={name} onChange={(e) => setName(e.target.value)} />
      </span>
      <button
        className="btn primary"
        disabled={!compiled}
        onClick={() => {
          saveCurrent(name || 'Untitled report')
          setSavedFlash(true)
          setTimeout(() => setSavedFlash(false), 1500)
        }}
      >
        {savedFlash ? 'Saved ✓' : 'Save'}
      </button>
      <button className="btn" onClick={share} disabled={!compiled}>{copied ? 'Link copied ✓' : 'Share link'}</button>
      <button className="btn" onClick={exportCsv} disabled={!result}>Export CSV</button>
      <button className="btn" onClick={clear} title="Start a blank report">New</button>
      <span className="spacer" />
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>
        Rows{' '}
        <select value={query.limit ?? 500} onChange={(e) => setLimit(Number(e.target.value))} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px' }}>
          {[...new Set([10, 25, 50, 100, 500, 2000, query.limit ?? 500])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="seg" title="Chart type">
        <button className={chart === 'auto' ? 'active' : ''} onClick={() => setChart('auto')}>Auto</button>
        {CHART_TYPES.map((c) => (
          <button key={c.value} className={chart === c.value ? 'active' : ''} onClick={() => setChart(c.value)}>{c.label}</button>
        ))}
      </div>
      <button className={`btn ${assistantOpen ? 'active' : ''}`} onClick={toggleAssistant}>✦ Ask</button>
      <button className={`btn ${explainOpen ? 'active' : ''}`} onClick={toggleExplain}>How is this calculated?</button>
    </div>
  )
}

export function Builder() {
  const explainOpen = useStore((s) => s.explainOpen)
  const assistantOpen = useStore((s) => s.assistantOpen)
  return (
    <div className="builder">
      <FieldPicker />
      <div className="main">
        <Toolbar />
        <Shelves />
        <ResultView />
      </div>
      {assistantOpen ? <Assistant /> : explainOpen ? <ExplainPanel /> : <div className="rightpanel hidden" />}
    </div>
  )
}
