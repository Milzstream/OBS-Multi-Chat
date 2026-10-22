import { useEffect, useRef, useState } from 'react'
import { moderationPlatformLabel, youtubeBanConfirmLabel } from '../chat-helpers'
import type { ModMenuState } from './types'

export function ModMenu({ menu, onModerate, onClose }: { menu: ModMenuState; onModerate: (action: 'delete' | 'timeout' | 'ban' | 'unban', duration?: number, reason?: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const prompt = menu.prompt
  const confirmOnly = Boolean(prompt?.confirmOnly)
  const prompting = Boolean(prompt)
  useEffect(() => {
    if (prompting && !confirmOnly) inputRef.current?.focus()
  }, [prompting, confirmOnly, prompt?.action, prompt?.duration])
  const width = prompting ? 228 : 168
  const height = confirmOnly ? 112 : prompting ? 168 : menu.message.deleted ? 90 : 190
  const platformLabel = moderationPlatformLabel(menu.message)
  return (
    <div className={prompting ? 'mod-menu mod-menu-prompt' : 'mod-menu'} style={{ left: Math.max(6, Math.min(menu.x, window.innerWidth - width)), top: Math.max(6, Math.min(menu.y, window.innerHeight - height)) }} onClick={(event) => event.stopPropagation()}>
      <div className="mod-menu-user">{menu.message.user} · {platformLabel}</div>
      {prompt?.confirmOnly ? (
        <form className="mod-menu-reason" onSubmit={(event) => { event.preventDefault(); onModerate(prompt.action, prompt.duration, '') }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }}>
          <label>{youtubeBanConfirmLabel(menu.message.user, platformLabel)}</label>
          <div className="mod-menu-actions">
            <button type="submit" className="danger">Ban</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      ) : prompt ? (
        <form className="mod-menu-reason" onSubmit={(event) => { event.preventDefault(); onModerate(prompt.action, prompt.duration, reason) }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }}>
          <label htmlFor="mod-reason">{prompt.action === 'ban' ? 'Ban' : 'Timeout'} on {platformLabel}. Reason is optional.</label>
          <input id="mod-reason" ref={inputRef} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (optional)" />
          <div className="mod-menu-actions">
            <button type="submit" className={prompt.action === 'ban' ? 'danger' : undefined}>{prompt.action === 'ban' ? 'Ban' : 'Timeout'}</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      ) : menu.message.deleted ? <button type="button" onClick={() => onModerate('unban')}>Unban / untimeout</button> : <>
        <button type="button" onClick={() => onModerate('delete')}>Delete message</button>
        <button type="button" onClick={() => onModerate('timeout', 60)}>Timeout 1m</button>
        <button type="button" onClick={() => onModerate('timeout', 600)}>Timeout 10m</button>
        <button type="button" onClick={() => onModerate('timeout', 3600)}>Timeout 1h</button>
        <button type="button" className="danger" onClick={() => onModerate('ban')}>Ban</button>
      </>}
    </div>
  )
}
