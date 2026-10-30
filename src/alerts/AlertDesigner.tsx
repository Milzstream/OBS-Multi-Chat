import React, { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, Bell, Play, Plus, RotateCcw, Save, Trash2, Twitch, Upload, Youtube } from 'lucide-react'
import { ALERT_FONTS, ALERT_TOKENS, alertFontCss, alertFontSelectOptions, parseAlertFontFamily } from '../../server/logic/alert-looks'
import type { AlertAssetRef, AlertLooks, AlertPlatform, AlertSettings, AlertTextAlign, AlertTextBox } from '../../server/types'
import {
  ALERT_PLATFORMS,
  alertAssetUrl,
  alertHoldSeconds,
  alertSoundGroup,
  usesCustomAlertLook,
} from './alerts'
import { AlertLookView, AlertPill } from './AlertVisual'
import {
  ALERT_PREVIEW_HEIGHT,
  ALERT_PREVIEW_WIDTH,
  clearLookLayer,
  defaultTextBox,
  designerKindsFor,
  inheritSources,
  insertToken,
  lookLayerHasContent,
  ownOrCopiedTextBoxes,
  readLookLayer,
  resolveAlertLookForTarget,
  resolvedGraphic,
  sampleAlertEvent,
  setLookAudio,
  setLookField,
  setLookGraphic,
  setLookTextBoxes,
  settleLooksSave,
  type LookTarget,
  type LooksSaveResult,
} from './designer'
import { playAlertSound, playAlertSoundUrl } from './sounds'

const GRAPHIC_ACCEPT = 'image/png,image/gif,image/webp,video/webm,video/mp4,.png,.gif,.webp,.webm,.mp4'
const AUDIO_ACCEPT = 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg'
const FONT_WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
] as const

function platformMark(platform: AlertPlatform, size = 14) {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  if (platform === 'Kick') return <span className="kick-mark">K</span>
  return <Bell size={size} strokeWidth={2.5} />
}

function readFileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

function hexColor(value: string | undefined) {
  const raw = (value || '#ffffff').trim()
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const [, a, b, c] = raw
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase()
  }
  return '#ffffff'
}

export function AlertDesigner({
  settings,
  onLooksChange,
  onBack,
}: {
  settings: AlertSettings
  onLooksChange: (looks: AlertLooks | undefined) => void | Promise<LooksSaveResult>
  onBack: () => void
}) {
  const [target, setTarget] = useState<LookTarget>({})
  const [draft, setDraft] = useState<AlertLooks | undefined>(settings.looks)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'graphic' | 'sound' | ''>('')
  const [timeDraft, setTimeDraft] = useState<string | null>(null)
  const [fonts, setFonts] = useState<string[]>(() => [...ALERT_FONTS])
  const [saveState, setSaveState] = useState<'unsaved' | 'saving' | 'saved' | 'error' | ''>('')
  const dirtyRef = useRef(false)
  const draftRef = useRef(draft)
  const dragRef = useRef<{ index: number; dx: number; dy: number } | null>(null)
  const saveTimer = useRef(0)
  const saveTail = useRef(Promise.resolve())
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const graphicInput = useRef<HTMLInputElement>(null)
  const soundInput = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const onLooksChangeRef = useRef(onLooksChange)
  onLooksChangeRef.current = onLooksChange

  useEffect(() => {
    // The console poll replaces settings.looks every 2s. An unsaved draft, including a drag, stays put.
    if (dirtyRef.current || dragRef.current) return
    draftRef.current = settings.looks
    setDraft(settings.looks)
  }, [settings.looks])

  useEffect(() => {
    let cancelled = false
    fetch('/api/alerts/fonts')
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { fonts?: unknown }) => {
        if (cancelled || !Array.isArray(body?.fonts)) return
        const next = alertFontSelectOptions(body.fonts.filter((name): name is string => typeof name === 'string'))
        if (next.length) setFonts(next)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const node = frameRef.current
    if (!node || typeof ResizeObserver === 'undefined') {
      if (node) setScale(node.clientWidth / ALERT_PREVIEW_WIDTH || 1)
      return
    }
    const update = () => setScale(node.clientWidth / ALERT_PREVIEW_WIDTH || 1)
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => observer.disconnect()
  }, [])

  const enqueue = <T,>(task: () => Promise<T>) => {
    const run = saveTail.current.then(task, task)
    saveTail.current = run.then(() => undefined, () => undefined)
    return run
  }

  const flushOnce = async () => {
    if (!dirtyRef.current && !dragRef.current) return
    const snapshot = draftRef.current
    setSaveState('saving')
    let result: LooksSaveResult
    try {
      result = await Promise.resolve(onLooksChangeRef.current(snapshot))
    } catch {
      if (draftRef.current === snapshot && !dragRef.current) setSaveState('error')
      return
    }
    const settlement = settleLooksSave(snapshot, draftRef.current, Boolean(dragRef.current), result)
    if (settlement === 'error') {
      setSaveState('error')
      return
    }
    if (settlement === 'dirty') {
      dirtyRef.current = true
      setSaveState('unsaved')
      return
    }
    dirtyRef.current = false
    setSaveState('saved')
  }

  // Looks POSTs run one at a time. Each one sends the draft at the moment it starts, so an older body cannot land last and prune a newer file.
  const persistLatest = () => enqueue(flushOnce)
  const persistLatestRef = useRef(persistLatest)
  persistLatestRef.current = persistLatest

  useEffect(() => () => {
    window.clearTimeout(saveTimer.current)
    if (dirtyRef.current || dragRef.current) void persistLatestRef.current()
  }, [])

  const commit = (looks: AlertLooks | undefined, immediate = false) => {
    dirtyRef.current = true
    draftRef.current = looks
    setDraft(looks)
    window.clearTimeout(saveTimer.current)
    if (immediate) void persistLatest()
    else {
      setSaveState('unsaved')
      saveTimer.current = window.setTimeout(() => { void persistLatestRef.current() }, 400)
    }
  }

  const event = sampleAlertEvent(target)
  const look = resolveAlertLookForTarget(draft, target)
  const custom = usesCustomAlertLook(look)
  const inherit = inheritSources(draft, target)
  const boxes = look?.textBoxes || []
  const graphic = resolvedGraphic(look)
  const own = readLookLayer(draft, target)
  const canReset = lookLayerHasContent(own)
  const kinds = designerKindsFor(target.platform)
  const hold = alertHoldSeconds(settings, look)
  const selectedBox = boxes[selected]
  const selectedFont = parseAlertFontFamily(selectedBox?.fontFamily) || 'Outfit'
  const fontOptions = alertFontSelectOptions(fonts, selectedFont)
  const previewSettings = { ...settings, displaySec: hold, enabled: true }

  const selectPlatform = (platform: AlertPlatform | undefined) => {
    setTarget(platform ? { platform } : {})
    setSelected(0)
    setTimeDraft(null)
  }
  const selectKind = (kind: string) => {
    setTarget((current) => current.kind === kind ? { platform: current.platform } : { platform: current.platform, kind })
    setSelected(0)
    setTimeDraft(null)
  }

  const mutateBoxes = (nextBoxes: AlertTextBox[], immediate = false) => {
    commit(setLookTextBoxes(draftRef.current, target, nextBoxes), immediate)
  }
  const editBoxes = (immediate = false) => {
    const base = draftRef.current
    const next = ownOrCopiedTextBoxes(base, target)
    if (!Array.isArray(readLookLayer(base, target)?.textBoxes)) commit(setLookTextBoxes(base, target, next), immediate)
    return next
  }

  const upload = async (file: File, slot: 'graphic' | 'sound') => {
    const picked = target
    setError('')
    setBusy(slot)
    window.clearTimeout(saveTimer.current)
    try {
      await enqueue(async () => {
        const data = await readFileDataUrl(file)
        const response = await fetch('/api/alerts/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, mime: file.type, data }),
        })
        const body = await response.json().catch(() => ({})) as AlertAssetRef & { error?: string }
        if (!response.ok) throw new Error(body.error || 'Could not upload that file')
        const next = slot === 'graphic'
          ? setLookGraphic(draftRef.current, picked, body)
          : setLookAudio(draftRef.current, picked, body)
        dirtyRef.current = true
        draftRef.current = next
        setDraft(next)
        await flushOnce()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that file')
      if (dirtyRef.current || dragRef.current) void persistLatest()
    } finally {
      setBusy('')
    }
  }

  const playSound = () => {
    if (look?.audio) playAlertSoundUrl(alertAssetUrl(look.audio.id))
    else playAlertSound(alertSoundGroup(event.kind))
  }

  const onBoxPointerDown = (index: number, pointer: ReactPointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current
    if (!frame) return
    pointer.preventDefault()
    pointer.currentTarget.setPointerCapture(pointer.pointerId)
    const rect = frame.getBoundingClientRect()
    const box = boxes[index]
    const x = ((pointer.clientX - rect.left) / rect.width) * 100
    const y = ((pointer.clientY - rect.top) / rect.height) * 100
    dragRef.current = { index, dx: x - box.x, dy: y - box.y }
    dirtyRef.current = true
    setSelected(index)
    editBoxes()
  }

  const onBoxPointerMove = (pointer: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const frame = frameRef.current
    if (!drag || !frame) return
    const rect = frame.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((pointer.clientX - rect.left) / rect.width) * 100 - drag.dx))
    const y = Math.min(100, Math.max(0, ((pointer.clientY - rect.top) / rect.height) * 100 - drag.dy))
    const next = ownOrCopiedTextBoxes(draftRef.current, target)
    if (!next[drag.index]) return
    next[drag.index] = { ...next[drag.index], x, y }
    const looks = setLookTextBoxes(draftRef.current, target, next)
    dirtyRef.current = true
    draftRef.current = looks
    setDraft(looks)
  }

  const onBoxPointerUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    commit(draftRef.current, true)
  }

  const patchBox = (index: number, patch: Partial<AlertTextBox>, immediate = false) => {
    const next = ownOrCopiedTextBoxes(draftRef.current, target)
    if (!next[index]) return
    next[index] = { ...next[index], ...patch }
    mutateBoxes(next, immediate)
    setSelected(index)
  }

  const addBox = () => {
    const next = ownOrCopiedTextBoxes(draftRef.current, target)
    if (next.length >= 8) return
    next.push(defaultTextBox())
    mutateBoxes(next, true)
    setSelected(next.length - 1)
    window.requestAnimationFrame(() => {
      const field = textRef.current
      if (!field) return
      field.focus()
      const end = field.value.length
      field.setSelectionRange(end, end)
    })
  }

  const removeBox = (index: number) => {
    const next = ownOrCopiedTextBoxes(draftRef.current, target).filter((_, i) => i !== index)
    mutateBoxes(next, true)
    setSelected(Math.max(0, index - 1))
  }

  const tokenClick = (token: string) => {
    const box = selectedBox
    if (!box) {
      const next = [...ownOrCopiedTextBoxes(draftRef.current, target), { ...defaultTextBox(), text: `{${token}}` }]
      mutateBoxes(next, true)
      setSelected(next.length - 1)
      return
    }
    const node = textRef.current
    const focused = Boolean(node && typeof document !== 'undefined' && document.activeElement === node)
    const start = focused && node ? node.selectionStart : box.text.length
    const end = focused && node ? node.selectionEnd : box.text.length
    const inserted = insertToken(box.text, token, start, end)
    patchBox(selected, { text: inserted.text }, true)
    window.requestAnimationFrame(() => {
      const field = textRef.current
      if (!field) return
      field.focus()
      field.setSelectionRange(inserted.cursor, inserted.cursor)
    })
  }

  const saveNow = () => {
    window.clearTimeout(saveTimer.current)
    dirtyRef.current = true
    void persistLatest()
  }

  const resetLook = () => {
    commit(clearLookLayer(draftRef.current, target), true)
  }

  const goBack = () => {
    window.clearTimeout(saveTimer.current)
    if (dirtyRef.current || dragRef.current) void persistLatest()
    onBack()
  }

  const commitTime = () => {
    if (timeDraft == null) return
    const raw = timeDraft.trim()
    setTimeDraft(null)
    if (!raw) {
      commit(setLookField(draftRef.current, target, 'displaySec', undefined), true)
      return
    }
    const seconds = Number(raw)
    if (!Number.isFinite(seconds) || seconds <= 0) return
    commit(setLookField(draftRef.current, target, 'displaySec', seconds), true)
  }

  return (
    <div className="alert-designer">
      <div className="alert-designer-bar">
        <button type="button" className="alert-designer-action" onClick={goBack}>
          <ArrowLeft size={14} strokeWidth={2.5} /> Back
        </button>
        <strong>Customize alerts</strong>
        <button
          type="button"
          className="alert-designer-action"
          disabled={!canReset || saveState === 'saving'}
          title={target.platform || target.kind ? 'Remove this look so it uses Default again' : 'Remove this look and use the built-in pill'}
          onClick={resetLook}
        >
          <RotateCcw size={12} strokeWidth={2.5} /> Reset to default
        </button>
        <button type="button" className="alert-designer-action" disabled={saveState === 'saving'} onClick={saveNow}>
          <Save size={12} strokeWidth={2.5} /> {saveState === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {saveState === 'saved' ? <span className="alert-designer-status">Saved</span> : null}
        {saveState === 'unsaved' ? <span className="alert-designer-status">Unsaved</span> : null}
        {saveState === 'error' ? <span className="alert-designer-status error">Could not save</span> : null}
        <span className="alert-designer-hint">Sample preview · 1000×250</span>
      </div>
      <div className="alert-designer-frame" ref={frameRef}>
        <div
          className="alert-designer-stage"
          style={{ transform: `scale(${scale})`, width: ALERT_PREVIEW_WIDTH, height: ALERT_PREVIEW_HEIGHT }}
        >
          <div className={custom ? 'alerts-stage alerts-stage-look' : 'alerts-stage'}>
            {custom && look ? (
              <AlertLookView event={event} settings={previewSettings} look={look} preview />
            ) : (
              <AlertPill event={event} settings={previewSettings} />
            )}
          </div>
          {custom ? boxes.map((box, index) => (
            <div
              key={index}
              className={`alert-designer-hit${selected === index ? ' selected' : ''}`}
              style={{
                left: `${box.x}%`,
                top: `${box.y}%`,
                width: box.width != null ? `${box.width}%` : undefined,
              }}
              onPointerDown={(pointer) => onBoxPointerDown(index, pointer)}
              onPointerMove={onBoxPointerMove}
              onPointerUp={onBoxPointerUp}
              onPointerCancel={onBoxPointerUp}
            />
          )) : null}
        </div>
      </div>
      <p className="alert-designer-inherit">
        {inherit.graphic.label} · {inherit.sound.label} · {inherit.text.label} · {inherit.time.label}
      </p>
      <div className="alert-designer-tabs">
        <button type="button" className={!target.platform ? 'active' : undefined} onClick={() => selectPlatform(undefined)}>Default</button>
        {ALERT_PLATFORMS.map((platform) => (
          <button
            key={platform}
            type="button"
            className={target.platform === platform ? 'active' : undefined}
            title={platform}
            onClick={() => selectPlatform(platform)}
          >
            {platformMark(platform)}
          </button>
        ))}
      </div>
      <div className="alert-designer-kinds">
        {kinds.map((item) => (
          <button
            key={item.kind}
            type="button"
            className={target.kind === item.kind ? 'active' : undefined}
            onClick={() => selectKind(item.kind)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="alert-designer-fields">
        <div className="alert-designer-row">
          <span>Graphic</span>
          <small>{graphic?.name || (inherit.graphic.cleared ? 'cleared' : 'none')}</small>
          <button type="button" disabled={busy === 'graphic'} onClick={() => graphicInput.current?.click()}>
            <Upload size={12} /> {busy === 'graphic' ? '…' : 'Upload'}
          </button>
          <button type="button" disabled={!graphic && !inherit.graphic.own} onClick={() => commit(setLookGraphic(draftRef.current, target, null), true)}>Clear</button>
          {inherit.graphic.own ? <button type="button" onClick={() => { commit(setLookField(setLookField(draftRef.current, target, 'image', undefined), target, 'video', undefined), true) }}>Inherit</button> : null}
          <input ref={graphicInput} type="file" accept={GRAPHIC_ACCEPT} hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file, 'graphic') }} />
        </div>
        <div className="alert-designer-row">
          <span>Sound</span>
          <small>{look?.audio?.name || (inherit.sound.cleared ? 'cleared' : 'built-in')}</small>
          <button type="button" disabled={busy === 'sound'} onClick={() => soundInput.current?.click()}>
            <Upload size={12} /> {busy === 'sound' ? '…' : 'Upload'}
          </button>
          <button type="button" disabled={!look?.audio && !inherit.sound.own} onClick={() => commit(setLookAudio(draftRef.current, target, null), true)}>Clear</button>
          {inherit.sound.own ? <button type="button" onClick={() => commit(setLookField(draftRef.current, target, 'audio', undefined), true)}>Inherit</button> : null}
          <button type="button" onClick={playSound} title="Preview sound"><Play size={12} /></button>
          <input ref={soundInput} type="file" accept={AUDIO_ACCEPT} hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file, 'sound') }} />
        </div>
        <label className="alert-designer-time">
          <span>Display time (seconds)</span>
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            placeholder={String(look?.displaySec || settings.displaySec)}
            value={timeDraft ?? (own?.displaySec != null ? String(own.displaySec) : '')}
            onChange={(event) => setTimeDraft(event.target.value)}
            onBlur={commitTime}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTime() } }}
          />
        </label>
        {error ? <p className="settings-jwt-error">{error}</p> : null}
        <div className="alert-designer-text-head">
          <span>Text</span>
          <span className="alert-designer-text-actions">
            {Array.isArray(own?.textBoxes) ? <button type="button" onClick={() => commit(setLookField(draftRef.current, target, 'textBoxes', undefined), true)}>Inherit</button> : null}
            <button type="button" disabled={boxes.length >= 8} onClick={addBox}><Plus size={12} /> Add</button>
          </span>
        </div>
        <div className="alert-designer-tokens">
          {ALERT_TOKENS.map((token) => (
            <button key={token} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => tokenClick(token)}>{`{${token}}`}</button>
          ))}
        </div>
        {selectedBox ? (
          <div className="alert-designer-box-edit">
            <textarea
              ref={textRef}
              value={selectedBox.text}
              rows={2}
              onChange={(event) => patchBox(selected, { text: event.target.value })}
              onBlur={() => commit(draftRef.current, true)}
            />
            <div className="alert-designer-box-tools">
              <label>X <input type="number" min={0} max={100} step={1} value={Math.round(selectedBox.x)} onChange={(event) => patchBox(selected, { x: Number(event.target.value) }, true)} /></label>
              <label>Y <input type="number" min={0} max={100} step={1} value={Math.round(selectedBox.y)} onChange={(event) => patchBox(selected, { y: Number(event.target.value) }, true)} /></label>
              <label>W <input type="number" min={0} max={100} step={1} value={Math.round(selectedBox.width ?? 100)} onChange={(event) => patchBox(selected, { width: Number(event.target.value) }, true)} /></label>
              <label>Size <input type="number" min={1} max={40} step={1} value={selectedBox.fontSize ?? 8} onChange={(event) => patchBox(selected, { fontSize: Number(event.target.value) }, true)} /></label>
              <label>Color <input type="color" value={hexColor(selectedBox.color)} onChange={(event) => patchBox(selected, { color: event.target.value }, true)} /></label>
              <label>
                Align
                <select value={selectedBox.align || 'left'} onChange={(event) => patchBox(selected, { align: event.target.value as AlertTextAlign }, true)}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label>
                Font
                <select
                  className="alert-designer-font"
                  value={selectedFont}
                  style={{ fontFamily: alertFontCss(selectedFont) }}
                  onChange={(event) => patchBox(selected, { fontFamily: event.target.value }, true)}
                >
                  {fontOptions.map((font) => (
                    <option key={font} value={font} style={{ fontFamily: alertFontCss(font) }}>{font}</option>
                  ))}
                </select>
              </label>
              <label>
                Weight
                <select value={selectedBox.fontWeight || 400} onChange={(event) => patchBox(selected, { fontWeight: Number(event.target.value) }, true)}>
                  {FONT_WEIGHTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <button type="button" title="Remove text box" onClick={() => removeBox(selected)}><Trash2 size={12} /></button>
            </div>
          </div>
        ) : (
          <p className="settings-note">Add a text box, then drag it on the preview. Tokens fill from the sample event.</p>
        )}
      </div>
    </div>
  )
}
