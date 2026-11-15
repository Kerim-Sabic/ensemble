import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { App } from './App'
import { useStore } from './store'

// Handy from the developer console, and used by the screenshot harness.
;(window as unknown as { __ensemble: typeof useStore }).__ensemble = useStore

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
