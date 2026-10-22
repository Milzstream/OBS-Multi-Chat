/**
 * Kick-only pure helpers: badges, emotes, live-poll failure, channel patch.
 */

import type { ChatBadge, MessagePart, StreamDetails } from '../types.js'
import { isMoreSpecificCategory, kickTagsForApi, normalizeTags } from './stream-info.js'

export function looksLikePlaceholder(handle: string) {
  return !handle || handle === 'Kick account' || handle.includes(' ')
}


export function kickChannelPollFailure(status: number) {
  if (status >= 200 && status < 300) return
  return {
    refresh: status === 401,
    message: status === 401 ? 'Kick status poll needs a token refresh' : `Kick status poll failed (${status})`,
  }
}

export function kickBadges(badges?: { type?: string; text?: string }[]): ChatBadge[] {
  return (badges || []).map((badge) => {
    const type = String(badge.type || '').toLowerCase()
    let label = ''
    if (type.includes('broadcaster') || type === 'og') label = 'HOST'
    else if (type.includes('mod')) label = 'MOD'
    else if (type.includes('sub')) label = 'SUB'
    else if (type.includes('vip')) label = 'VIP'
    else if (type.includes('verified')) label = '✓'
    else if (type.includes('staff')) label = 'STAFF'
    else if (type.includes('founder')) label = 'OG'
    return { title: badge.text || badge.type || label, label }
  }).filter((badge) => badge.label).slice(0, 4)
}

export function kickEmoteUrl(id: string) {
  return `https://files.kick.com/emotes/${encodeURIComponent(id)}/fullsize`
}

export function parseKickParts(text: string, emotes?: any[]): MessagePart[] {
  const token = /\[emote:(\d+):([^\]]+)\]/g
  const parts: MessagePart[] = []
  let cursor = 0
  let matched = false
  for (const match of text.matchAll(token)) {
    matched = true
    const index = match.index || 0
    if (index > cursor) parts.push({ type: 'text', text: text.slice(cursor, index) })
    parts.push({ type: 'emote', name: match[2], url: kickEmoteUrl(match[1]) })
    cursor = index + match[0].length
  }
  if (matched) {
    if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
    return parts.length ? parts : [{ type: 'text', text }]
  }
  if (emotes?.length) {
    const ranges = emotes.flatMap((emote) => {
      const id = String(emote.emote_id || emote.id || '')
      const name = String(emote.name || '')
      return (emote.positions || []).map((position: any) => ({ start: Number(position.s ?? position.start), end: Number(position.e ?? position.end), id, name }))
    }).filter((range) => range.id && Number.isFinite(range.start) && Number.isFinite(range.end)).sort((left, right) => left.start - right.start)
    if (ranges.length) {
      let offset = 0
      for (const range of ranges) {
        if (range.start < offset) continue
        if (range.start > offset) parts.push({ type: 'text', text: text.slice(offset, range.start) })
        parts.push({ type: 'emote', name: range.name || text.slice(range.start, range.end + 1), url: kickEmoteUrl(range.id) })
        offset = range.end + 1
      }
      if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) })
      return parts.length ? parts : [{ type: 'text', text }]
    }
  }
  return [{ type: 'text', text }]
}

export function kickCategorySkipped(category?: string, categoryId?: string) {
  return Boolean(category?.trim()) && !String(categoryId || '').trim()
}

export function kickChannelPatch(info: { title: string; category?: string; categoryId?: string; tags?: string[] }) {
  const tags = kickTagsForApi(info.tags)
  return {
    body: {
      stream_title: info.title,
      ...(info.categoryId ? { category_id: Number(info.categoryId) } : {}),
      ...(tags?.length ? { custom_tags: tags } : {}),
    },
    warning: kickCategorySkipped(info.category, info.categoryId) ? 'Kick category was not updated. Pick a category from the list.' : undefined,
  }
}


export function kickStreamDetails(channel: any): StreamDetails {
  const candidates = [
    channel?.category,
    channel?.subcategory,
    channel?.livestream?.category,
    ...(Array.isArray(channel?.livestream?.categories) ? channel.livestream.categories : []),
  ]
  let best: { name: string; id?: string } | undefined
  for (const item of candidates) {
    const name = String(item?.name || '').trim()
    const id = item?.id != null && String(item.id).trim() ? String(item.id) : undefined
    if (!name) continue
    if (!best || isMoreSpecificCategory(name, best.name) || (id && !best.id && name.toLowerCase() === best.name.toLowerCase())) best = { name, id }
  }
  const tags = normalizeTags(channel?.stream?.custom_tags)
  return { title: String(channel?.stream_title || '').trim(), category: best?.name || '', ...(best?.id ? { categoryId: best.id } : {}), ...(tags ? { tags } : {}) }
}


export function shouldWarnKickChatDown(connected: boolean, failed: boolean) {
  return !connected && failed
}

