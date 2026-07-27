import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// vite.config.ts's `registerType: 'autoUpdate'` makes each deploy's service
// worker skipWaiting + clientsClaim automatically, but that only changes
// which SW answers future requests — it does nothing to the JS already
// running in an open tab/installed PWA. Without this listener, travelers
// who leave the app open across a deploy stay on the old build (a stale
// bundle referencing asset URLs a fresh deploy may have already removed)
// until they manually force-quit and relaunch.
if ('serviceWorker' in navigator) {
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
