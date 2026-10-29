import React, { type CSSProperties } from 'react'
import { KindIcon, PlatformMark, kindColor, platformColor, type ActivityEvent } from '../activity/ActivityRow'
import { activityKindLabel, activityPlanColor, activityPlanLabel, activitySubtitle, pillTextColor } from '../activity/format'
import {
  alertAssetUrl,
  alertHoldSeconds,
  alertTemplateValues,
  fillAlertTemplate,
  neutralAlertColor,
  neutralAlertLabel,
  neutralAlertText,
  type AlertLook,
  type AlertSettings,
  type AlertTextBox,
} from './alerts'

export function textBoxStyle(box: AlertTextBox): CSSProperties {
  return {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: box.width != null ? `${box.width}%` : undefined,
    textAlign: box.align || 'left',
    color: box.color || '#fff',
    fontSize: `${box.fontSize && box.fontSize > 0 ? box.fontSize : 8}em`,
    fontWeight: box.fontWeight,
  }
}

export function AlertPill({ event, settings }: { event: ActivityEvent; settings: AlertSettings }) {
  const source = event.source || event.platform
  const showPlatform = settings.showPlatform
  const color = showPlatform ? platformColor[event.platform] : neutralAlertColor(event)
  const badge = showPlatform ? kindColor(event) : neutralAlertColor(event)
  const label = showPlatform ? activityKindLabel(event) : neutralAlertLabel(event)
  const subtitle = activitySubtitle(event)
  const detail = showPlatform ? subtitle : neutralAlertText(subtitle)
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

export function AlertLookView({
  event,
  settings,
  look,
  preview = false,
}: {
  event: ActivityEvent
  settings: AlertSettings
  look: AlertLook
  preview?: boolean
}) {
  const hold = alertHoldSeconds(settings, look)
  const values = alertTemplateValues(event, settings.showPlatform)
  const video = look.video
  const image = look.image
  const muteVideo = preview || !settings.sound || Boolean(look.audio)
  return (
    <div className="alert-look" style={{ ['--alert-sec' as string]: `${hold}s` }}>
      {video ? (
        <video
          className="alert-look-media"
          src={alertAssetUrl(video.id)}
          autoPlay
          playsInline
          loop={preview}
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
