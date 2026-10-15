import { findDimension, findMeasure, findMetric } from '../core/model'
import { templates } from '../data/templates'
import { useStore } from './store'

function fieldLabels(model: ReturnType<typeof useStore.getState>['model'], refs: string[], kind: 'dim' | 'measure'): string[] {
  return refs.map((r) => {
    try {
      if (kind === 'dim') return findDimension(model, r).dim.label
      return findMetric(model, r)?.label ?? findMeasure(model, r).measure.label
    } catch {
      return r
    }
  })
}

export function TemplatesGallery() {
  const model = useStore((s) => s.model)
  const loadTemplate = useStore((s) => s.loadTemplate)
  const clear = useStore((s) => s.clear)
  const setView = useStore((s) => s.setView)
  const audiences = [...new Set(templates.map((t) => t.audience))]
  return (
    <div className="gallery">
      <h2>Start from a report people actually use</h2>
      <p className="lead">
        Open one, change the grouping or the date range, and it is yours. Or{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); clear(); setView('builder') }}>start from scratch</a>.
      </p>
      {audiences.map((a) => (
        <div key={a} style={{ marginBottom: 24 }}>
          <h4 style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>For the {a.toLowerCase()}</h4>
          <div className="cards">
            {templates.filter((t) => t.audience === a).map((t) => (
              <button className="card" key={t.id} onClick={() => loadTemplate(t.id)}>
                <b>{t.name}</b>
                <p>{t.description}</p>
                <div className="fields">
                  {fieldLabels(model, t.query.measures, 'measure').map((l) => <span className="tag" key={l}>{l}</span>)}
                  {fieldLabels(model, t.query.dimensions, 'dim').map((l) => <span className="tag" key={l}>by {l}</span>)}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SavedList() {
  const saved = useStore((s) => s.saved)
  const loadSaved = useStore((s) => s.loadSaved)
  const deleteSaved = useStore((s) => s.deleteSaved)
  const setView = useStore((s) => s.setView)
  const model = useStore((s) => s.model)
  return (
    <div className="gallery">
      <h2>Your saved reports</h2>
      <p className="lead">Saved in this browser. Share one with the link button in the builder.</p>
      {saved.length === 0 && (
        <div className="msg hint">
          Nothing saved yet. Open a <a href="#" onClick={(e) => { e.preventDefault(); setView('templates') }}>template</a>, adjust it, and press Save.
        </div>
      )}
      <div className="cards">
        {saved.map((r) => (
          <div className="card" key={r.id} onClick={() => loadSaved(r.id)} role="button">
            <b>{r.name}</b>
            <p>Saved {new Date(r.savedAt).toLocaleString()}</p>
            <div className="fields">
              {fieldLabels(model, r.query.measures, 'measure').map((l) => <span className="tag" key={l}>{l}</span>)}
              {fieldLabels(model, r.query.dimensions, 'dim').map((l) => <span className="tag" key={l}>by {l}</span>)}
            </div>
            <div className="actions">
              <button
                className="btn"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSaved(r.id)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
