import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ActivityApp from './activity/ActivityApp'
import './styles.css'

const path = location.pathname.replace(/\/$/, '') || '/'
const activity = path === '/activity' || new URLSearchParams(location.search).get('view') === 'activity'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {activity ? <ActivityApp /> : <App />}
  </StrictMode>,
)
