import { useEffect } from 'react'
import { Builder } from './ui/Builder'
import { SavedList, TemplatesGallery } from './ui/Gallery'
import { useStore } from './ui/store'

export default function App() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const dbReady = useStore((s) => s.dbReady)
  const dbError = useStore((s) => s.dbError)
  const warmup = useStore((s) => s.warmup)
  const saved = useStore((s) => s.saved)
  const model = useStore((s) => s.model)

  useEffect(() => {
    void warmup()
  }, [warmup])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Wonder <span>Reports</span></div>
        <nav className="nav">
          <button className={view === 'templates' ? 'active' : ''} onClick={() => setView('templates')}>Templates</button>
          <button className={view === 'builder' ? 'active' : ''} onClick={() => setView('builder')}>Builder</button>
          <button className={view === 'saved' ? 'active' : ''} onClick={() => setView('saved')}>Saved{saved.length ? ` (${saved.length})` : ''}</button>
        </nav>
        <span className="status">
          {dbError ? 'Data engine failed' : dbReady ? `${model.name} · sample data, in-browser` : <><span className="spinner" /> Loading data engine…</>}
        </span>
      </header>
      {view === 'templates' && <TemplatesGallery />}
      {view === 'saved' && <SavedList />}
      {view === 'builder' && <Builder />}
    </div>
  )
}
