import { useState, type MouseEvent } from 'react'
import { chatProfileUrl, dockAvatarSrc, openDockUrl, profileLinkTitle } from '../chat-helpers'
import { platformIcon, platformMeta } from './platform'
import type { ChatMessage } from './types'

function displayLetter(name: string) {
  const cleaned = name.replace(/^@+/, '')
  return (cleaned.match(/[\p{L}\p{N}]/u)?.[0] || cleaned[0] || '?').toUpperCase()
}

function Avatar({ name, src, color }: { name: string; src?: string; color: string }) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const showImage = Boolean(src) && src !== failedSrc
  return <div className="avatar" style={{ backgroundColor: showImage ? 'transparent' : color }}>{showImage ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} /> : displayLetter(name)}</div>
}

export function MessageItem({ message, rowIndex, channelLogin, showTranslationMark, onModerate }: { message: ChatMessage; rowIndex: number; channelLogin?: string; showTranslationMark: boolean; onModerate: (event: MouseEvent, message: ChatMessage) => void }) {
  const platforms = message.platforms || [message.platform]
  const parts = message.parts?.length ? message.parts : [{ type: 'text' as const, text: message.text }]
  const name = message.user.replace(/^@+/, '')
  const profileUrl = chatProfileUrl(message, channelLogin)
  const openProfile = (event: MouseEvent) => {
    if (!profileUrl) return
    event.stopPropagation()
    openDockUrl(profileUrl)
  }
  return <article data-row-index={rowIndex} className={message.deleted ? 'message deleted' : 'message'} onContextMenu={(event) => onModerate(event, message)}><Avatar name={name} src={dockAvatarSrc(message.avatar)} color={message.color || platformMeta[platforms[0]].color} /><div className="message-body"><div className="message-meta"><span className="platform-dot">{platforms.map((platform) => <span key={platform} style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 11)}</span>)}</span>{message.sourceLabel ? <span className="source-tag">{message.sourceLabel}</span> : null}{(message.badges || []).map((badge, index) => badge.url ? <img key={`${badge.title}-${index}`} className="chat-badge" src={dockAvatarSrc(badge.url)} alt={badge.title} title={badge.title} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : badge.label ? <span key={`${badge.title}-${index}`} className="chat-badge-label" title={badge.title}>{badge.label}</span> : null)}<strong style={message.color ? { color: message.color } : undefined} title={profileUrl ? profileLinkTitle(message.platform) : undefined} onClick={profileUrl ? openProfile : undefined} className={profileUrl ? 'clickable-username' : ''}>{name}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p title={showTranslationMark ? message.originalText || undefined : undefined}>{parts.map((part, index) => part.type === 'emote' ? <img key={`${part.url}-${index}`} className="emote" src={dockAvatarSrc(part.url)} alt={part.name} title={part.name} referrerPolicy="no-referrer" /> : <span key={index}>{part.text}</span>)}{message.deleted && parts.some((part) => part.type === 'emote') && (message.platform === 'Kick' || (message.platforms || []).includes('Kick')) ? <span className="deleted-note" title="Banned by a moderator">(Banned)</span> : null}{showTranslationMark && message.originalText ? <span className="translated-mark" title={message.originalText}>EN</span> : null}</p></div></article>
}
