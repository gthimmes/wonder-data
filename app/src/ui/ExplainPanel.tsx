import { useStore } from './store'

/**
 * "How was this calculated." Written for a business reader first; SQL last,
 * collapsed, for anyone who wants to verify.
 */
export function ExplainPanel() {
  const compiled = useStore((s) => s.compiled)
  const compileError = useStore((s) => s.compileError)
  const toggle = useStore((s) => s.toggleExplain)
  const result = useStore((s) => s.result)

  return (
    <div className="rightpanel">
      <div className="ph">
        How this was calculated
        <button className="btn" onClick={toggle}>Close</button>
      </div>
      <div className="body">
        {compileError && <div className="msg warn">{compileError}</div>}
        {compiled && (
          <>
            <h4>In one sentence</h4>
            <p>{compiled.explanation.summary}</p>

            <h4>Each number</h4>
            {compiled.explanation.measures.length === 0 && <p style={{ color: 'var(--muted)' }}>No numbers yet; this report lists distinct values.</p>}
            {compiled.explanation.measures.map((m, i) => (
              <div className="explain-measure" key={i}>
                <b>{m.label}</b>
                <span>{sentence(m.definition)}</span>
                <div className="path">Data path: {m.path}</div>
              </div>
            ))}

            <h4>Filters</h4>
            {compiled.explanation.filters.length ? (
              <ul>
                {compiled.explanation.filters.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : (
              <p style={{ color: 'var(--muted)' }}>None. Every record is included.</p>
            )}

            {compiled.explanation.compare && (
              <>
                <h4>Comparison</h4>
                <p>{compiled.explanation.compare.description}</p>
              </>
            )}

            <h4>Guarantees</h4>
            <ul>
              <li>Each total is added up inside its own table before tables are combined, so joins can never double count.</li>
              <li>Ratios divide the totals, never average the rows.</li>
              <li>Relative dates are fixed to the exact range shown above when the report runs.</li>
              <li>Click any row in the table to see the records behind it; they add up to the number shown.</li>
              {result && <li>Ran in {Math.round(result.elapsedMs)} ms on {result.rowCount.toLocaleString()} result rows.</li>}
            </ul>

            <details style={{ marginTop: 12 }}>
              <summary>Show the SQL</summary>
              <pre className="sql">{compiled.sql}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

function sentence(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(t) ? t : t + '.'
}
