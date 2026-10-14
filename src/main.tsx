import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ActivityApp from './activity/ActivityApp'
import AlertsApp from './alerts/AlertsApp'
import ConsoleApp from './ConsoleApp'
import { dockView } from './dock-view'
import WatchApp from './WatchApp'
import './styles.css'

/**
 * React entry point. `/` is the chat dock, `/activity` the activity dock,
 * `/console` the companion, `/watch` the readonly LAN page, and `/alerts` the OBS alert source.
 */

const view = dockView(location.pathname, location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'companion' ? <ConsoleApp /> : view === 'watch' ? <WatchApp /> : view === 'alerts' ? <AlertsApp /> : view === 'activity' ? <ActivityApp /> : <App />}
  </StrictMode>,
)
