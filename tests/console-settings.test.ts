import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { applySettingsPatch, mergeJwtDraft, mergePolledSettings, restoreSettingsKeys, settingsInFlightKeys, settingsSaveError } from '../src/ConsoleApp.tsx'
import { ConnectionSettings } from '../src/ConnectionSettings.tsx'

describe('auto live check toggle', () => {
  const connection = { platform: 'Twitch' as const, viewers: 1, handle: 'ada', connected: true, live: false }
  const render = (autoLiveCheck?: { Twitch: boolean }) => renderToStaticMarkup(createElement(ConnectionSettings, {
    connections: [connection],
    platformIcon: () => null,
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onCheckLive: () => undefined,
    autoLiveCheck,
    onToggleAutoLiveCheck: () => undefined,
  }))
  const checkbox = (html: string, label: string) => html.split('<input').find((part) => part.includes(`aria-label="${label}"`)) || ''

  it('checks Auto by default and leaves it unchecked when that platform is off', () => {
    const on = render()
    assert.match(checkbox(on, 'Auto-check Twitch live'), /checked/)
    assert.match(on, />Auto</)
    assert.match(on, /Check live/)
    const off = render({ Twitch: false })
    assert.doesNotMatch(checkbox(off, 'Auto-check Twitch live'), /checked/)
  })
})

describe('companion settings poll', () => {
  const current = {
    translateChat: true,
    translateError: '',
    activityFallback: true,
    ignoreMissingJwt: false,
    dropOldAlerts: false,
    autoLiveCheck: { Twitch: true, Kick: true, YouTube: true },
    streamelements: { connected: false, handle: '', connecting: true },
    youtubeQuota: { used: 1, limit: 10000 },
  }

  it('keeps an in-flight toggle and an edited JWT when a poll returns the old value', () => {
    const keys = settingsInFlightKeys({ translateChat: false, autoLiveCheck: { Kick: false } })
    assert.deepEqual(keys, ['translateChat', 'autoLiveCheck.Kick'])
    const optimistic = { ...current, translateChat: false, autoLiveCheck: { ...current.autoLiveCheck, Kick: false } }
    const polled = mergePolledSettings(optimistic, {
      translateChat: true,
      activityFallback: false,
      autoLiveCheck: { Twitch: true, Kick: true, YouTube: false },
    }, new Set(keys))
    assert.equal(polled.translateChat, false)
    assert.equal(polled.activityFallback, false)
    assert.equal(polled.autoLiveCheck.Kick, false)
    assert.equal(polled.autoLiveCheck.YouTube, false)
    const draft = mergeJwtDraft({ Twitch: 'pasted', Kick: '', YouTube: '' }, { Twitch: '', Kick: 'server', YouTube: 'yt' }, new Set(['Twitch']))
    assert.equal(draft.Twitch, 'pasted')
    assert.equal(draft.Kick, 'server')
    assert.equal(draft.YouTube, 'yt')
  })

  it('applies the server value after the post settles, and shows the error body on failure', () => {
    const optimistic = applySettingsPatch(current, { translateChat: false })
    assert.equal(optimistic.translateChat, false)
    const restored = restoreSettingsKeys(optimistic, current, ['translateChat'])
    assert.equal(restored.translateChat, true)
    assert.equal(settingsSaveError(false, 503, { error: 'watch bind failed' }), 'watch bind failed')
    assert.equal(settingsSaveError(false, 500, {}), 'Could not save settings (500)')
    assert.equal(settingsSaveError(true, 200, {}), '')
  })
})
