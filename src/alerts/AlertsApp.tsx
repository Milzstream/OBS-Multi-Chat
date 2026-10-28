import { useEffect, useRef, useState } from 'react'
import { KindIcon, PlatformMark, kindColor, platformColor, type ActivityEvent } from '../activity/ActivityRow'
import { activityKindLabel, activityPlanColor, activityPlanLabel, activitySubtitle, pillTextColor } from '../activity/format'
import { activityDockFields, subscribeDockSse } from '../sse'
import { DEFAULT_ALERT_SETTINGS, alertSoundGroup, createAlertTracker, enqueueAlerts, isAlertAllowed, neutralAlertColor, neutralAlertLabel, neutralAlertText, parseAlertSettings, type AlertSettings } from './alerts'
import { playAlertSound } from './sounds'

const GAP_MS = 400
const DEFAULT_CAP = 1000

/** Transparent browser-source page: shows each new alert once, one at a time, in arrival order. */
export default function AlertsApp() {
  const [current, setCurrent] = useState<ActivityEvent | null>(null)
  const [queue, setQueue] = useState<ActivityEvent[]>([])
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS)
  const settingsRef = useRef(settings)
  const capRef = useRef(DEFAULT_CAP)
  const trackerRef = useRef(createAlertTracker())
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
    if (settings.sound) playAlertSound(alertSoundGroup(next.kind))
  }, [current, queue, settings.enabled, settings.sound])

  useEffect(() => {
    if (!current) return
    const hold = window.setTimeout(() => setCurrent(null), settings.displaySec * 1000 + GAP_MS)
    return () => window.clearTimeout(hold)
  }, [current, settings.displaySec])

  if (!current || !settings.enabled) return <main className="alerts-stage" />
  const source = current.source || current.platform
  const showPlatform = settings.showPlatform
  const color = showPlatform ? platformColor[current.platform] : neutralAlertColor(current)
  const badge = showPlatform ? kindColor(current) : neutralAlertColor(current)
  const label = showPlatform ? activityKindLabel(current) : neutralAlertLabel(current)
  const subtitle = activitySubtitle(current)
  const detail = showPlatform ? subtitle : neutralAlertText(subtitle)
  // PRIME and the tier name Twitch, so the platform-neutral pill leaves the plan out.
  const plan = showPlatform ? activityPlanLabel(current) : undefined
  return (
    <main className="alerts-stage">
      <div
        key={current.id}
        className="activity-row alert-pill"
        style={{ ['--row-color' as string]: color, ['--alert-sec' as string]: `${settings.displaySec}s` }}
      >
        {showPlatform ? <span className="activity-icon" style={{ color: platformColor[source] }}><PlatformMark platform={source} /></span> : null}
        <span className="activity-icon" style={{ color }}><KindIcon kind={current.kind} /></span>
        <div className="activity-copy">
          <strong>{current.user}</strong>
          {detail ? <small>{detail}</small> : null}
        </div>
        {plan ? <span className="activity-plan" style={{ color: activityPlanColor(current.tier) }}>{plan}</span> : null}
        <span className="activity-kind" style={{ background: badge, color: pillTextColor(badge) }}>{label}</span>
      </div>
    </main>
  )
}
