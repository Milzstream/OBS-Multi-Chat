import React, { useEffect, useRef, useState, type CSSProperties } from 'react'
import { KindIcon, PlatformMark, kindColor, platformColor, type ActivityEvent } from '../activity/ActivityRow'
import { activityKindLabel, activityPlanColor, activityPlanLabel, activitySubtitle, pillTextColor } from '../activity/format'
import { activityDockFields, subscribeDockSse } from '../sse'
import {
  DEFAULT_ALERT_SETTINGS,
  alertAssetUrl,
  alertHoldSeconds,
  alertSoundGroup,
  alertTemplateValues,
  createAlertPresenter,
  enqueueAlerts,
  fillAlertTemplate,
  isAlertAllowed,
  neutralAlertColor,
  neutralAlertLabel,
  neutralAlertText,
  parseAlertSettings,
  resolveAlertLook,
  usesCustomAlertLook,
  type AlertLook,
  type AlertSettings,
  type AlertTextBox,
} from './alerts'
import { playAlertSound, playAlertSoundUrl } from './sounds'

const GAP_MS = 400
const DEFAULT_CAP = 1000

function textBoxStyle(box: AlertTextBox): CSSProperties {
  return {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: box.width != null ? `${box.width}%` : undefined,
    textAlign: box.align || 'left',
    color: box.color || '#fff',
    fontSize: `${box.fontSize && box.fontSize > 0 ? box.fontSize : 8}vh`,
    fontWeight: box.fontWeight,
  }
}

function AlertPill({ event, settings }: { event: ActivityEvent; settings: AlertSettings }) {
  const source = event.source || event.platform
  const showPlatform = settings.showPlatform
  const color = showPlatform ? platformColor[event.platform] : neutralAlertColor(event)
  const badge = showPlatform ? kindColor(event) : neutralAlertColor(event)
  const label = showPlatform ? activityKindLabel(event) : neutralAlertLabel(event)
  const subtitle = activitySubtitle(event)
  const detail = showPlatform ? subtitle : neutralAlertText(subtitle)
  // PRIME and the tier name Twitch, so the platform-neutral pill leaves the plan out.
  const plan = showPlatform ? activityPlanLabel(event) : undefined
  return (
    <div
      key={event.id}
      className="activity-row alert-pill"
      style={{ ['--row-color' as string]: color, ['--alert-sec' as string]: `${settings.displaySec}s` }}
    >
      {showPlatform ? <span className="activity-icon" style={{ color: platformColor[source] }}><PlatformMark platform={source} /></span> : null}
      <span className="activity-icon" style={{ color }}><KindIcon kind={event.kind} /></span>
      <div className="activity-copy">
        <strong>{event.user}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      {plan ? <span className="activity-plan" style={{ color: activityPlanColor(event.tier) }}>{plan}</span> : null}
      <span className="activity-kind" style={{ background: badge, color: pillTextColor(badge) }}>{label}</span>
    </div>
  )
}

export function AlertLookView({ event, settings, look }: { event: ActivityEvent; settings: AlertSettings; look: AlertLook }) {
  const hold = alertHoldSeconds(settings, look)
  const values = alertTemplateValues(event, settings.showPlatform)
  const video = look.video
  const image = look.image
  const muteVideo = !settings.sound || Boolean(look.audio)
  return (
    <div className="alert-look" style={{ ['--alert-sec' as string]: `${hold}s` }}>
      {video ? (
        <video
          className="alert-look-media"
          src={alertAssetUrl(video.id)}
          autoPlay
          playsInline
          muted={muteVideo}
        />
      ) : image ? (
        <img className="alert-look-media" src={alertAssetUrl(image.id)} alt="" />
      ) : null}
      {(look.textBoxes || []).map((box, index) => (
        <div key={index} className="alert-look-text" style={textBoxStyle(box)}>{fillAlertTemplate(box.text, values)}</div>
      ))}
    </div>
  )
}

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
