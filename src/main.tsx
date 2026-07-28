import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './online.css'
import './online-player.css'
import './compat-v04.css'
import './story-v05.css'
import './unified-v06.css'
import './crafting-v07.css'
import './market-v08.css'
import './trade-v09.css'
import './artifact-v010.css'
import './region-v011.css'
import './marsh-v012.css'
import './combat-v013.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed:', error)
    })
  })
}
