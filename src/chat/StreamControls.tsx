import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { applyExactCategory, assignTagPlatforms, categoryPickNote, commitTypedCategory, exactCategoryMatch, mergeCategoryResults, nextOptionIndex, preferredCategory, tagAssignments, unifiedCategoryQuery, youtubeStudioUrl, type MergedCategory, type TagAssignment, type TagPlatform } from '../chat-helpers'
import { platformIcon, platformMeta } from './platform'
import type { CategoryOption, Connection, StreamDetails, StreamDetailsByPlatform, StreamPlatform } from './types'

/** Twitch/Kick category field. Arrow keys only move the open list; closed input keeps default caret behavior. */
function StreamFields({ platform, details, disabled, onChange }: { platform: StreamPlatform; details: StreamDetails; disabled: boolean; onChange: (details: StreamDetails) => void }) {
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const typingRef = useRef(false)
  const pickedRef = useRef(false)
  const visible = options.slice(0, 8)
  useEffect(() => {
    if (disabled || details.category.trim().length < 2) { setOptions([]); setOpen(false); return }
    if (pickedRef.current) { pickedRef.current = false; setOpen(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(details.category.trim())}`, { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<CategoryOption[]> : Promise.reject()).then((items) => { setOptions(items); setOpen(typingRef.current && items.length > 0) }).catch((error: { name?: string }) => { if (error.name !== 'AbortError') { setOptions([]); setOpen(false) } })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [details.category, disabled, platform])
  useEffect(() => { setHighlight(0) }, [details.category, open])
  const pick = (option: CategoryOption) => { pickedRef.current = true; typingRef.current = false; setOpen(false); setOptions([]); onChange({ ...details, category: option.name, categoryId: option.id }) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || visible.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => nextOptionIndex(current, visible.length, 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => nextOptionIndex(current, visible.length, -1))
      return
    }
    if (event.key === 'Enter') {
      const option = visible[highlight]
      if (!option) return
      event.preventDefault()
      pick(option)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }
  return <div className="stream-fields"><div className="stream-fields-heading"><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 13)}</span><strong>{platform} category</strong><small>{disabled ? `Connect ${platform}` : 'Platform-specific'}</small></div><input disabled={disabled} autoComplete="off" value={details.category} onChange={(event) => { pickedRef.current = false; typingRef.current = true; onChange(commitTypedCategory(details, event.target.value)) }} onKeyDown={onKeyDown} onBlur={() => { typingRef.current = false; window.setTimeout(() => setOpen(false), 120) }} placeholder={`${platform} category / game`} aria-expanded={open} aria-autocomplete="list" />{open && visible.length > 0 && <ul className="category-options" role="listbox">{visible.map((option, index) => <li key={option.id}><button type="button" className={index === highlight ? 'active' : undefined} aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); pick(option) }}>{option.name}</button></li>)}</ul>}</div>
}

/** Combined Twitch+Kick category search. Shared names are one row; platform-only hits keep their icon. */
function UnifiedCategoryField({ twitch, kick, twitchEnabled, kickEnabled, onChange }: { twitch: StreamDetails; kick: StreamDetails; twitchEnabled: boolean; kickEnabled: boolean; onChange: (next: { Twitch: StreamDetails; Kick: StreamDetails }, note?: string) => void }) {
  const [query, setQuery] = useState(preferredCategory(twitch.category, kick.category))
  const [options, setOptions] = useState<MergedCategory[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const typingRef = useRef(false)
  const pickedRef = useRef(false)
  const visible = options.slice(0, 8)
  useEffect(() => {
    setQuery((current) => unifiedCategoryQuery(current, twitch.category, kick.category, typingRef.current))
  }, [twitch.category, kick.category])
  useEffect(() => {
    if ((!twitchEnabled && !kickEnabled) || query.trim().length < 2) { setOptions([]); setOpen(false); return }
    if (pickedRef.current) { pickedRef.current = false; setOpen(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const load = async (platform: StreamPlatform) => {
        const response = await fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        if (!response.ok) return [] as CategoryOption[]
        return response.json() as Promise<CategoryOption[]>
      }
      void Promise.all([
        twitchEnabled ? load('Twitch') : Promise.resolve([] as CategoryOption[]),
        kickEnabled ? load('Kick') : Promise.resolve([] as CategoryOption[]),
      ]).then(([twitchHits, kickHits]) => {
        const merged = mergeCategoryResults(twitchHits, kickHits)
        setOptions(merged)
        setOpen(typingRef.current && merged.length > 0)
      }).catch((error: { name?: string }) => { if (error.name !== 'AbortError') { setOptions([]); setOpen(false) } })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, twitchEnabled, kickEnabled])
  useEffect(() => { setHighlight(0) }, [query, open])
  const pick = (option: MergedCategory) => {
    pickedRef.current = true
    typingRef.current = false
    setOpen(false)
    setOptions([])
    setQuery(option.name)
    onChange({
      Twitch: option.twitchId ? { ...twitch, category: option.name, categoryId: option.twitchId } : twitch,
      Kick: option.kickId ? { ...kick, category: option.name, categoryId: option.kickId } : kick,
    }, categoryPickNote(option.name, option.twitchId, option.kickId))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || visible.length === 0) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((current) => nextOptionIndex(current, visible.length, 1)); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((current) => nextOptionIndex(current, visible.length, -1)); return }
    if (event.key === 'Enter') {
      const option = visible[highlight]
      if (!option) return
      event.preventDefault()
      pick(option)
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }
  return (
    <div className="stream-fields">
      <div className="stream-fields-heading"><strong>Category</strong><small>Twitch + Kick</small></div>
      <input disabled={!twitchEnabled && !kickEnabled} autoComplete="off" value={query} onChange={(event) => { pickedRef.current = false; typingRef.current = true; const text = event.target.value; setQuery(text); onChange({ Twitch: commitTypedCategory(twitch, text), Kick: commitTypedCategory(kick, text) }) }} onKeyDown={onKeyDown} onBlur={() => { typingRef.current = false; window.setTimeout(() => setOpen(false), 120) }} placeholder="Category / game" aria-expanded={open} aria-autocomplete="list" />
      {open && visible.length > 0 && (
        <ul className="category-options" role="listbox">
          {visible.map((option, index) => (
            <li key={`${option.twitchId || ''}-${option.kickId || ''}-${option.name}`}>
              <button type="button" className={index === highlight ? 'active' : undefined} aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); pick(option) }}>
                <span>{option.name}</span>
                <span className="category-option-platforms">
                  {option.twitchId ? <span style={{ color: platformMeta.Twitch.color }}>{platformIcon('Twitch', 12)}</span> : null}
                  {option.kickId ? <span style={{ color: platformMeta.Kick.color }}>{platformIcon('Kick', 12)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Chip input for stream tags. Destination toggles pick Twitch / Kick / YouTube for the next chip. */
function TagEditor({ tags, disabled, connected, onChange }: { tags: TagAssignment[]; disabled: boolean; connected: Record<TagPlatform, boolean>; onChange: (tags: TagAssignment[]) => void }) {
  const [draft, setDraft] = useState('')
  const [dest, setDest] = useState<Record<TagPlatform, boolean>>({ Twitch: true, Kick: true })
  const selected = (['Twitch', 'Kick'] as TagPlatform[]).filter((platform) => dest[platform] && connected[platform])
  const commit = (raw: string) => {
    const pieces = raw.split(/[\s,]+/).map((item) => item.trim().replace(/^#+/, '')).filter(Boolean)
    if (!pieces.length) return
    const next = tags.map((item) => ({ tag: item.tag, platforms: [...item.platforms] }))
    for (const piece of pieces) {
      const use = assignTagPlatforms(piece, selected)
      if (!use.length) continue
      const existing = next.find((item) => item.tag.toLowerCase() === piece.toLowerCase())
      if (existing) {
        existing.platforms = [...new Set([...existing.platforms, ...use])]
        continue
      }
      if (next.length >= 10) break
      next.push({ tag: piece, platforms: use })
    }
    setDraft('')
    onChange(next)
  }
  return (
    <div className="tag-editor">
      {tags.map((item) => {
        return (
          <button type="button" key={item.tag} className="tag-chip" disabled={disabled} onClick={() => onChange(tags.filter((entry) => entry.tag !== item.tag))} title={item.platforms.join(' + ')}>
            <span className="tag-chip-platforms">{item.platforms.map((platform) => <i key={platform} style={{ background: platformMeta[platform].color }} />)}</span>
            {item.tag} ×
          </button>
        )
      })}
      {tags.length < 10 ? (
        <input disabled={disabled} value={draft} autoComplete="off" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(draft) }
          if (event.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
        }} onBlur={() => { if (draft.trim()) commit(draft) }} placeholder="Tags" />
      ) : null}
      <div className="tag-dest">
        {(['Twitch', 'Kick'] as TagPlatform[]).map((platform) => (
          <button type="button" key={platform} className={dest[platform] ? 'active' : undefined} disabled={disabled || !connected[platform]} style={{ color: platformMeta[platform].color }} aria-pressed={dest[platform]} aria-label={`${platform} tags`} title={platform} onClick={() => setDest((current) => ({ ...current, [platform]: !current[platform] }))}>
            {platformIcon(platform, 12)}
          </button>
        ))}
      </div>
    </div>
  )
}

async function resolveCategory(platform: StreamPlatform, query: string) {
  const text = query.trim()
  if (text.length < 2) return
  try {
    const response = await fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(text)}`)
    if (!response.ok) return
    return exactCategoryMatch(text, await response.json() as CategoryOption[])
  } catch {
    return
  }
}

export function StreamControls({ title, details, connections, onSave, onClose }: { title: string; details: StreamDetailsByPlatform; connections: Connection[]; onSave: (title: string, details: StreamDetailsByPlatform) => Promise<{ ok: boolean; warn?: boolean; message: string }>; onClose: () => void }) {
  const [draftTitle, setDraftTitle] = useState(title || details.Twitch.title || details.Kick.title)
  const [draftDetails, setDraftDetails] = useState(details)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null)
  const [splitCategories, setSplitCategories] = useState(() => {
    const twitch = details.Twitch.category.trim().toLowerCase()
    const kick = details.Kick.category.trim().toLowerCase()
    return Boolean(twitch && kick && twitch !== kick)
  })
  const editedRef = useRef(false)
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 4500)
    return () => window.clearTimeout(timer)
  }, [status])
  useEffect(() => {
    if (editedRef.current) return
    setDraftTitle(title || details.Twitch.title || details.Kick.title)
    setDraftDetails(details)
    let cancelled = false
    void (async () => {
      const [twitchMatch, kickMatch] = await Promise.all([
        details.Twitch.categoryId || !details.Twitch.category.trim() ? undefined : resolveCategory('Twitch', details.Twitch.category),
        details.Kick.categoryId || !details.Kick.category.trim() ? undefined : resolveCategory('Kick', details.Kick.category),
      ])
      if (cancelled || editedRef.current) return
      setDraftDetails((current) => ({
        Twitch: applyExactCategory(current.Twitch, twitchMatch),
        Kick: applyExactCategory(current.Kick, kickMatch),
        YouTube: current.YouTube,
      }))
    })()
    return () => { cancelled = true }
  }, [title, details])
  const save = async () => {
    setSaving(true)
    const [twitchMatch, kickMatch] = await Promise.all([
      draftDetails.Twitch.categoryId || !draftDetails.Twitch.category.trim() ? undefined : resolveCategory('Twitch', draftDetails.Twitch.category),
      draftDetails.Kick.categoryId || !draftDetails.Kick.category.trim() ? undefined : resolveCategory('Kick', draftDetails.Kick.category),
    ])
    const next = {
      ...draftDetails,
      Twitch: applyExactCategory(draftDetails.Twitch, twitchMatch),
      Kick: applyExactCategory(draftDetails.Kick, kickMatch),
    }
    setDraftDetails(next)
    const result = await onSave(draftTitle, next)
    setStatus({ text: result.message, kind: result.ok ? (result.warn ? 'warn' : 'ok') : 'error' })
    if (result.ok) editedRef.current = false
    setSaving(false)
  }
  const youtubeConnected = Boolean(connections.find((connection) => connection.platform === 'YouTube')?.connected)
  const twitchConnected = Boolean(connections.find((connection) => connection.platform === 'Twitch')?.connected)
  const kickConnected = Boolean(connections.find((connection) => connection.platform === 'Kick')?.connected)
  const tagsDisabled = !twitchConnected && !kickConnected
  const youtubeChannelId = connections.find((connection) => connection.platform === 'YouTube')?.channelId
  const openYouTubeStudio = () => {
    void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: youtubeStudioUrl(youtubeChannelId) }) }).catch((error) => console.error('Failed to open YouTube Studio:', error))
  }
  const setTags = (tags: TagAssignment[]) => {
    editedRef.current = true
    setDraftDetails((current) => ({
      ...current,
      Twitch: { ...current.Twitch, tags: tags.filter((item) => item.platforms.includes('Twitch')).map((item) => item.tag) },
      Kick: { ...current.Kick, tags: tags.filter((item) => item.platforms.includes('Kick')).map((item) => item.tag) },
    }))
  }
  return (
    <aside className="controls-popover">
      <div className="popover-title"><span>STREAM CONTROLS</span><button onClick={onClose} aria-label="Close stream controls">×</button></div>
      <div className="control-tabs"><span className="unified-badge">TWITCH + KICK</span><button type="button" className="controls-link" disabled={!youtubeConnected} onClick={openYouTubeStudio}>Open YouTube Studio</button></div>
      <div className="stream-fields">
        <div className="stream-fields-heading"><strong>Title</strong></div>
        <input value={draftTitle} onChange={(event) => { editedRef.current = true; setDraftTitle(event.target.value) }} placeholder="Shared stream title" />
      </div>
      {splitCategories
        ? (['Twitch', 'Kick'] as StreamPlatform[]).map((platform) => <StreamFields key={platform} platform={platform} details={draftDetails[platform]} disabled={!connections.find((connection) => connection.platform === platform)?.connected} onChange={(next) => { editedRef.current = true; setDraftDetails((current) => ({ ...current, [platform]: next })) }} />)
        : <UnifiedCategoryField twitch={draftDetails.Twitch} kick={draftDetails.Kick} twitchEnabled={twitchConnected} kickEnabled={kickConnected} onChange={(next, note) => { editedRef.current = true; setDraftDetails((current) => ({ ...current, ...next })); if (note) setStatus({ text: note, kind: 'warn' }) }} />}
      <button type="button" className="controls-link" onClick={() => setSplitCategories((open) => !open)}>{splitCategories ? 'Use one category search' : 'Twitch / Kick separately'}</button>
      <div className="stream-fields">
        <div className="stream-fields-heading"><strong>Tags</strong></div>
        <TagEditor tags={tagAssignments(draftDetails.Twitch.tags, draftDetails.Kick.tags)} disabled={tagsDisabled} connected={{ Twitch: twitchConnected, Kick: kickConnected }} onChange={setTags} />
      </div>
      <button className="update-stream" disabled={saving} onClick={() => { void save() }}>{saving ? 'Saving...' : 'Set title, categories, and tags'}</button>
      {status ? <div className={`stream-status ${status.kind}`}>{status.text}</div> : null}
    </aside>
  )
}
