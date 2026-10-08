import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ActivityApp from './activity/ActivityApp'
import ConsoleApp from './ConsoleApp'
import { dockView } from './dock-view'
import WatchApp from './WatchApp'
import './styles.css'

/**
 * React entry point. `/` is the chat dock, `/activity` the activity dock,
 * `/console` the companion, and `/watch` the readonly LAN page.
 */

const view = dockView(location.pathname, location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'companion' ? <ConsoleApp /> : view === 'watch' ? <WatchApp /> : view === 'activity' ? <ActivityApp /> : <App />}
  </StrictMode>,
)
