import React from 'react'
import { youtubePrivacyMessage, type YoutubePrivacyNotice } from './chat-helpers'

/** Warning line for an unlisted or private broadcast. The title attribute keeps the full name when the dock clips it. */
export function YoutubePrivacyBanner({ notice, className, status, onPublic, onDismiss }: { notice: YoutubePrivacyNotice; className: string; status?: string; onPublic: () => void; onDismiss: () => void }) {
  return (
    <div className={className} role="status">
      <span className="youtube-privacy-text" title={notice.title}>{youtubePrivacyMessage(notice)}</span>
      <span className="youtube-privacy-actions">
        <button type="button" onClick={onPublic}>Make public</button>
        <button type="button" onClick={onDismiss}>Dismiss</button>
      </span>
      {status ? <small>{status}</small> : null}
    </div>
  )
}
