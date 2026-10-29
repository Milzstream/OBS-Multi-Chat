import React, { useEffect, useRef, useState } from 'react'
import { type ActivityEvent } from '../activity/ActivityRow'
import { activityDockFields, subscribeDockSse } from '../sse'
import {
  DEFAULT_ALERT_SETTINGS,
  alertAssetUrl,
  alertHoldSeconds,
  alertSoundGroup,
  createAlertPresenter,
  enqueueAlerts,
  isAlertAllowed,
  parseAlertSettings,
  resolveAlertLook,
  usesCustomAlertLook,
  type AlertSettings,
} from './alerts'
import { AlertLookView, AlertPill } from './AlertVisual'
import { playAlertSound, playAlertSoundUrl } from './sounds'

export { AlertLookView, AlertPill } from './AlertVisual'

const GAP_MS = 400
const DEFAULT_CAP = 1000

/** Pill or custom look for one event. */
function AlertStage({ event, settings }: { event: ActivityEvent; settings: AlertSettings }) {
  const look = resolveAlertLook(settings, event)
  const custom = usesCustomAlertLook(look)
  const hold = alertHoldSeconds(settings, look)
  return (
    <main className={custom ? 'alerts-stage alerts-stage-look' : 'alerts-stage'}>
      {custom && look ? (
        <AlertLookView event={event} settings={{ ...settings, displaySec: hold }} look={look} />
      ) : (
        <AlertPill event={event} settings={{ ...settings, displaySec: hold }} />
      )}
    </main>
  )
}

/** Transparent browser-source page: shows each new alert once, one at a time, in arrival order. */
export default function AlertsApp() {
  const [current, setCurrent] = useState<ActivityEvent | null>(null)
  const [queue, setQueue] = useState<ActivityEvent[]>([])
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS)
  const settingsRef = useRef(settings)
  const capRef = useRef(DEFAULT_CAP)
  const trackerRef = useRef(createAlertPresenter())
  settingsRef.current = settings

  useEffect(() => {
    document.title = 'Relay Alerts'
    document.documentElement.classList.add('alerts-page')
    return () => document.documentElement.classList.remove('alerts-page')
  }, [])

  useEffect(() => {
    const tracker = trackerRef.current
    let bootId = ''
    const apply = (data: Record<string, unknown>, snapshot: boolean) => {
      if (snapshot && typeof data.bootId === 'string') {
        if (bootId && bootId !== data.bootId) {
          window.location.reload()
          return
        }
        bootId = data.bootId
      }
      if ('alerts' in data) {
        const next = parseAlertSettings(data.alerts)
        settingsRef.current = next
        setSettings(next)
        if (!next.enabled) setQueue([])
      }
      if (typeof data.activityMax === 'number' && data.activityMax > 0) capRef.current = data.activityMax
      const fields = activityDockFields(data)
      const events = Array.isArray(fields.activity) ? fields.activity as ActivityEvent[] : fields.activityEvent ? [fields.activityEvent as ActivityEvent] : []
      if (!events.length && !(snapshot && !tracker.primed())) return
      const fresh = tracker.ingest(events, snapshot)
      const live = settingsRef.current
      if (!live.enabled) return
      const allowed = fresh.filter((event) => isAlertAllowed(event, live.disabled))
      if (allowed.length) setQueue((previous) => enqueueAlerts(previous, allowed, capRef.current))
    }
    return subscribeDockSse({
      onSnapshot: (data) => apply(data, true),
      onActivity: (data) => apply(data, false),
      onSettings: (data) => apply(data, false),
      onStatus: () => undefined,
    })
  }, [])

  useEffect(() => {
    if (current || !queue.length || !settings.enabled) return
    const [next, ...rest] = queue
    setQueue(rest)
    setCurrent(next)
    if (settings.sound) {
      const look = resolveAlertLook(settings, next)
      if (look?.audio) playAlertSoundUrl(alertAssetUrl(look.audio.id))
      else playAlertSound(alertSoundGroup(next.kind))
    }
  }, [current, queue, settings])

  const holdSec = current ? alertHoldSeconds(settings, resolveAlertLook(settings, current)) : settings.displaySec

  useEffect(() => {
    if (!current) return
    const hold = window.setTimeout(() => setCurrent(null), holdSec * 1000 + GAP_MS)
    return () => window.clearTimeout(hold)
  }, [current, holdSec])

  if (!current || !settings.enabled) return <main className="alerts-stage" />
  return <AlertStage event={current} settings={settings} />
}
