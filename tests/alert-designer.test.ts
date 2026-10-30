import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { AlertLookView } from '../src/alerts/AlertsApp.tsx'
import { AlertDesigner } from '../src/alerts/AlertDesigner.tsx'
import {
  DESIGNER_KINDS,
  designerKindsFor,
  inheritSources,
  insertToken,
  lookTargetKind,
  ownOrCopiedTextBoxes,
  readLookLayer,
  resolveAlertLookForTarget,
  resolvedGraphic,
  sampleAlertEvent,
  setLookAudio,
  setLookField,
  setLookGraphic,
  setLookTextBoxes,
  clearLookLayer,
  lookLayerHasContent,
  settleLooksSave,
  copyResolvedLook,
  copySources,
} from '../src/alerts/designer.ts'
import { collectLookAssetIds, parseAlertSettings, resolveAlertLook } from '../src/alerts/alerts.ts'
import { dockView } from '../src/dock-view.ts'
import { ALERT_LOOK_KINDS } from '../server/logic.js'

const IMAGE = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mime: 'image/png' as const, name: 'banner.png' }
const TWITCH = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', mime: 'image/png' as const, name: 'twitch.png' }
const SOUND = { id: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', mime: 'audio/mpeg' as const, name: 'cheer.mp3' }
const VIDEO = { id: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa', mime: 'video/webm' as const, name: 'clip.webm' }

describe('designer kind list', () => {
  it('is Follow, Sub, Gift, Cheer, Raid, Donation, Merch, Super Chat, Membership, with no Power-up', () => {
    assert.deepEqual(DESIGNER_KINDS.map((item) => item.label), [
      'Follow', 'Sub', 'Gift', 'Cheer', 'Raid', 'Donation', 'Merch', 'Super Chat', 'Membership',
    ])
    assert.equal(DESIGNER_KINDS.some((item) => /power/i.test(item.kind) || /power/i.test(item.label)), false)
    assert.equal((ALERT_LOOK_KINDS as readonly string[]).includes('powerup'), false)
    assert.deepEqual(designerKindsFor('Twitch').map((item) => item.kind), ['follow', 'subscription', 'gift', 'cheer', 'raid'])
    assert.deepEqual(designerKindsFor('StreamElements').map((item) => item.kind), ['donation', 'merch'])
  })
})

describe('sample events', () => {
  it('fills Ada plus kind-specific amount, months, viewers, and gifter', () => {
    assert.equal(sampleAlertEvent({}).user, 'Ada')
    assert.equal(sampleAlertEvent({}).platform, 'Twitch')
    assert.equal(sampleAlertEvent({}).kind, 'follow')
    assert.equal(sampleAlertEvent({ platform: 'Kick' }).kind, 'follow')
    assert.equal(sampleAlertEvent({ platform: 'YouTube' }).kind, 'subscription')
    assert.equal(sampleAlertEvent({ kind: 'cheer' }).amount, '100 Bits')
    assert.equal(sampleAlertEvent({ platform: 'Kick', kind: 'cheer' }).amount, '100 Kicks')
    assert.equal(sampleAlertEvent({ kind: 'gift' }).giftedBy, 'Cal')
    assert.equal(sampleAlertEvent({ kind: 'gift' }).amount, '5 gifts')
    assert.equal(sampleAlertEvent({ kind: 'raid' }).viewers, 12)
    assert.equal(sampleAlertEvent({ kind: 'subscription' }).months, 4)
    assert.equal(sampleAlertEvent({ kind: 'donation' }).platform, 'StreamElements')
    assert.equal(sampleAlertEvent({ kind: 'superchat' }).platform, 'YouTube')
    assert.equal(sampleAlertEvent({ kind: 'membership' }).platform, 'YouTube')
  })
})

describe('look targets and cascade up to the edited layer', () => {
  const looks = {
    default: { image: IMAGE, audio: SOUND, textBoxes: [{ text: '{name}', x: 10, y: 20 }], displaySec: 6 },
    platforms: { Twitch: { audio: { ...SOUND, name: 'twitch.mp3' } } },
    kinds: { follow: { textBoxes: [{ text: 'FOLLOW {name}', x: 5, y: 5 }] } },
    slots: { 'Twitch:follow': { image: { ...IMAGE, name: 'follow.png' } } },
  }

  it('editing default does not show a more-specific slot graphic', () => {
    const resolved = resolveAlertLookForTarget(looks, {})
    assert.equal(resolvedGraphic(resolved)?.name, 'banner.png')
    assert.equal(resolved?.audio?.name, 'cheer.mp3')
    assert.equal(resolved?.textBoxes?.[0]?.text, '{name}')
    const live = resolveAlertLook({ looks }, { platform: 'Twitch', kind: 'follow' })
    assert.equal(live?.image?.name, 'follow.png')
  })

  it('editing Twitch uses default plus the platform layer', () => {
    const resolved = resolveAlertLookForTarget(looks, { platform: 'Twitch' })
    assert.equal(resolvedGraphic(resolved)?.name, 'banner.png')
    assert.equal(resolved?.audio?.name, 'twitch.mp3')
    assert.equal(resolved?.textBoxes?.[0]?.text, '{name}')
  })

  it('editing Follow (all platforms) uses default plus the kind layer', () => {
    const resolved = resolveAlertLookForTarget(looks, { kind: 'follow' })
    assert.equal(resolved?.textBoxes?.[0]?.text, 'FOLLOW {name}')
    assert.equal(resolvedGraphic(resolved)?.name, 'banner.png')
  })

  it('editing Twitch Follow uses the full cascade', () => {
    const resolved = resolveAlertLookForTarget(looks, { platform: 'Twitch', kind: 'follow' })
    assert.equal(resolvedGraphic(resolved)?.name, 'follow.png')
    assert.equal(resolved?.audio?.name, 'twitch.mp3')
    assert.equal(resolved?.textBoxes?.[0]?.text, 'FOLLOW {name}')
    assert.equal(lookTargetKind({ platform: 'Twitch', kind: 'follow' }), 'slot')
  })

  it('a platform image beats Follow on every platform, and other platforms keep that Follow', () => {
    const layered = {
      kinds: { follow: { image: { ...IMAGE, name: 'follow-all.png' } } },
      platforms: { Twitch: { image: { ...TWITCH, name: 'twitch.png' } } },
    }
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(layered, { platform: 'Twitch', kind: 'follow' }))?.name, 'twitch.png')
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(layered, { platform: 'Kick', kind: 'follow' }))?.name, 'follow-all.png')
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(layered, { kind: 'follow' }))?.name, 'follow-all.png')
  })
})

describe('set look fields', () => {
  it('writes default, platform, kind, and slot layers and drops empty ones', () => {
    let looks = setLookGraphic(undefined, {}, IMAGE)
    assert.equal(looks?.default?.image?.id, IMAGE.id)
    looks = setLookAudio(looks, { platform: 'Twitch' }, SOUND)
    assert.equal(looks?.platforms?.Twitch?.audio?.id, SOUND.id)
    looks = setLookTextBoxes(looks, { kind: 'follow' }, [{ text: '{name}', x: 1, y: 2 }])
    assert.equal(looks?.kinds?.follow?.textBoxes?.[0]?.text, '{name}')
    looks = setLookField(looks, { platform: 'Twitch', kind: 'follow' }, 'displaySec', 8)
    assert.equal(looks?.slots?.['Twitch:follow']?.displaySec, 8)
    looks = setLookField(looks, { platform: 'Twitch', kind: 'follow' }, 'displaySec', undefined)
    assert.equal(looks?.slots, undefined)
    looks = setLookGraphic(looks, {}, null)
    assert.equal(looks?.default?.image, undefined)
  })

  it('resets a layer so Default or the pill shows again', () => {
    let looks = setLookGraphic(undefined, {}, IMAGE)
    looks = setLookGraphic(looks, { platform: 'Twitch' }, TWITCH)
    looks = setLookTextBoxes(looks, { platform: 'Twitch', kind: 'follow' }, [{ text: '{name}', x: 8, y: 40 }])
    assert.equal(lookLayerHasContent(readLookLayer(looks, { platform: 'Twitch' })), true)
    looks = clearLookLayer(looks, { platform: 'Twitch', kind: 'follow' })
    assert.equal(looks?.slots, undefined)
    looks = clearLookLayer(looks, { platform: 'Twitch' })
    assert.equal(looks?.platforms, undefined)
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(looks, { platform: 'Twitch' }))?.id, IMAGE.id)
    looks = clearLookLayer(looks, {})
    assert.equal(looks, undefined)
    assert.equal(lookLayerHasContent(undefined), false)
  })

  it('clears an overlay graphic with null so inherited art does not show', () => {
    let looks = setLookGraphic(undefined, {}, IMAGE)
    looks = setLookGraphic(looks, { platform: 'Twitch' }, null)
    const own = readLookLayer(looks, { platform: 'Twitch' })
    assert.equal(own?.image, null)
    assert.equal(own?.video, null)
    const resolved = resolveAlertLookForTarget(looks, { platform: 'Twitch' })
    assert.equal(resolvedGraphic(resolved), undefined)
    const inherit = inheritSources(looks, { platform: 'Twitch' })
    assert.equal(inherit.graphic.cleared, true)
    assert.match(inherit.graphic.label, /cleared/i)
  })

  it('setting a video graphic clears image on that layer', () => {
    let looks = setLookGraphic(undefined, {}, IMAGE)
    looks = setLookGraphic(looks, { platform: 'Kick' }, VIDEO)
    assert.equal(readLookLayer(looks, { platform: 'Kick' })?.video?.id, VIDEO.id)
    assert.equal(readLookLayer(looks, { platform: 'Kick' })?.image, null)
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(looks, { platform: 'Kick' }))?.id, VIDEO.id)
  })

  it('copies inherited text boxes on first edit', () => {
    const looks = setLookTextBoxes(undefined, {}, [{ text: 'from default', x: 8, y: 40 }])
    const copied = ownOrCopiedTextBoxes(looks, { platform: 'Twitch' })
    assert.equal(copied[0]?.text, 'from default')
    copied[0].text = 'own'
    assert.equal(readLookLayer(looks, { platform: 'Twitch' })?.textBoxes, undefined)
    const next = setLookTextBoxes(looks, { platform: 'Twitch' }, copied)
    assert.equal(readLookLayer(next, { platform: 'Twitch' })?.textBoxes?.[0]?.text, 'own')
    assert.equal(readLookLayer(next, {})?.textBoxes?.[0]?.text, 'from default')
  })

  it('inserts {tokens} at the cursor', () => {
    const result = insertToken('Ada ', 'amount', 4, 4)
    assert.equal(result.text, 'Ada {amount}')
    assert.equal(result.cursor, 12)
  })
})

describe('inherit labels', () => {
  it('names the layer a field came from', () => {
    const looks = {
      default: { audio: SOUND, image: IMAGE },
      platforms: { Twitch: { audio: { ...SOUND, name: 'twitch.mp3' } } },
    }
    const twitch = inheritSources(looks, { platform: 'Twitch' })
    assert.equal(twitch.graphic.label, 'Graphic from default')
    assert.equal(twitch.sound.label, 'Sound from this look')
    assert.equal(twitch.time.label, 'Display time from global')
    const fallback = inheritSources(looks, {})
    assert.equal(fallback.graphic.label, 'Graphic from this look')
    assert.equal(fallback.sound.label, 'Sound from this look')
  })
})

describe('copy a whole look', () => {
  it('stores what you see on the current alert and does not follow later source edits', () => {
    const looks = { default: { image: IMAGE, textBoxes: [{ text: '{name}', x: 1, y: 2 }] } }
    const copied = copyResolvedLook(looks, {}, { platform: 'Twitch', kind: 'follow' })
    assert.equal(readLookLayer(copied, { platform: 'Twitch', kind: 'follow' })?.image?.id, IMAGE.id)
    assert.equal(readLookLayer(copied, { platform: 'Twitch', kind: 'follow' })?.textBoxes?.[0]?.text, '{name}')
    const changed = setLookGraphic(copied, {}, TWITCH)
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(changed, { platform: 'Twitch', kind: 'follow' }))?.id, IMAGE.id)
    assert.equal(resolvedGraphic(resolveAlertLookForTarget(changed, {}))?.id, TWITCH.id)
    const choices = copySources(looks, { platform: 'Twitch', kind: 'follow' })
    assert.deepEqual(choices.map((item) => item.label), ['Default'])
    assert.equal(copySources(looks, {}).length, 0)
  })
})

describe('looks save settlement', () => {
  const looks = { default: { image: IMAGE } }
  const newer = { default: { image: TWITCH } }

  it('clears dirty only when the snapshot that finished is still the draft', () => {
    assert.equal(settleLooksSave(looks, looks, false, true), 'saved')
    assert.equal(settleLooksSave(looks, looks, false, undefined), 'saved')
    assert.equal(settleLooksSave(looks, newer, false, true), 'dirty')
    assert.equal(settleLooksSave(looks, looks, true, true), 'dirty')
    assert.equal(settleLooksSave(looks, looks, false, 'stale'), 'dirty')
    assert.equal(settleLooksSave(looks, looks, false, false), 'error')
    assert.equal(settleLooksSave(looks, newer, false, false), 'dirty')
  })

  it('keeps an earlier asset when a second upload is applied to the latest draft', () => {
    const withGraphic = setLookGraphic(undefined, {}, IMAGE)
    const withBoth = setLookAudio(withGraphic, {}, SOUND)
    assert.equal(withBoth?.default?.image?.id, IMAGE.id)
    assert.equal(withBoth?.default?.audio?.id, SOUND.id)
  })
})

describe('asset ids on a looks tree', () => {
  it('collects image, video, and audio ids and skips nulls', () => {
    const ids = collectLookAssetIds({
      default: { image: IMAGE, audio: null },
      platforms: { Twitch: { video: VIDEO } },
      kinds: { cheer: { audio: SOUND } },
      slots: { 'Twitch:cheer': { image: null } },
    })
    assert.deepEqual(ids.sort(), [IMAGE.id, VIDEO.id, SOUND.id].sort())
    assert.deepEqual(collectLookAssetIds(undefined), [])
  })
})

describe('companion designer markup', () => {
  it('renders Customize with the v1 kind list and token buttons, and no Power-up', () => {
    const html = renderToStaticMarkup(createElement(AlertDesigner, {
      settings: parseAlertSettings({ enabled: true }),
      onLooksChange: () => undefined,
      onBack: () => undefined,
    }))
    assert.match(html, /Customize alerts/)
    assert.match(html, /alert-designer-action/)
    assert.match(html, /Save<\/button>/)
    assert.match(html, /Reset all custom looks/)
    assert.match(html, /Copy from/)
    assert.doesNotMatch(html, />Inherit</)
    assert.match(html, /title="Shared look for every alert/)
    assert.match(html, /<button[^>]*disabled[^>]*title="Clear the shared look and use the plain pill"/)
    assert.match(html, />Default</)
    assert.match(html, />Follow</)
    assert.match(html, />Membership</)
    assert.match(html, /\{name\}/)
    assert.match(html, /\{gifter\}/)
    assert.match(html, /alert-pill/)
    assert.doesNotMatch(html, /power-?up/i)
  })

  it('enables Reset to default when this look has a custom graphic', () => {
    const html = renderToStaticMarkup(createElement(AlertDesigner, {
      settings: parseAlertSettings({
        enabled: true,
        looks: { default: { image: IMAGE } },
      }),
      onLooksChange: () => undefined,
      onBack: () => undefined,
    }))
    assert.match(html, /Reset<\/button>/)
    assert.match(html, /Save<\/button>/)
    const resetAll = html.split('Reset all custom looks')[0].split('<button').pop() || ''
    assert.doesNotMatch(resetAll, /disabled/)
    const reset = html.split('alert-designer-reset')[1]?.split('</button>')[0] || ''
    assert.doesNotMatch(reset, /disabled/)
  })

  it('offers Copy from Default and Clear for owned text, with no Inherit button', () => {
    const html = renderToStaticMarkup(createElement(AlertDesigner, {
      settings: parseAlertSettings({
        enabled: true,
        looks: { default: { textBoxes: [{ text: '{name}', x: 8, y: 40 }] } },
      }),
      onLooksChange: () => undefined,
      onBack: () => undefined,
    }))
    assert.match(html, /Copy from…/)
    assert.match(html, /alert-designer-copy" disabled/)
    assert.doesNotMatch(html, />Inherit</)
    const actions = html.split('alert-designer-text-actions')[1]?.split('alert-designer-tokens')[0] || ''
    assert.match(actions, />Clear<\/button>/)
    assert.doesNotMatch(actions, /disabled/)
    assert.match(actions, /Add<\/button>/)
  })

  it('drops a platform text override so Default shows again', () => {
    const looks = {
      default: { textBoxes: [{ text: '{name}', x: 8, y: 40 }] },
      platforms: { Twitch: { textBoxes: [{ text: 'only twitch', x: 1, y: 1 }] } },
    }
    assert.equal(resolveAlertLookForTarget(looks, { platform: 'Twitch' })?.textBoxes?.[0]?.text, 'only twitch')
    const inherited = setLookField(looks, { platform: 'Twitch' }, 'textBoxes', undefined)
    assert.equal(resolveAlertLookForTarget(inherited, { platform: 'Twitch' })?.textBoxes?.[0]?.text, '{name}')
    assert.equal(readLookLayer(inherited, {})?.textBoxes?.[0]?.text, '{name}')
  })

  it('offers a Font picker with Outfit, common faces, and the selected family', () => {
    const html = renderToStaticMarkup(createElement(AlertDesigner, {
      settings: parseAlertSettings({
        enabled: true,
        looks: { default: { textBoxes: [{ text: '{name}', x: 8, y: 40, fontFamily: 'impact' }] } },
      }),
      onLooksChange: () => undefined,
      onBack: () => undefined,
    }))
    assert.match(html, />Font</)
    assert.match(html, /<option[^>]*value="Impact"/)
    assert.match(html, />Outfit</)
    assert.match(html, />Comic Sans MS</)
    assert.doesNotMatch(html, /url\(/)
  })
})

describe('overlay route stays output-only', () => {
  it('does not mount the designer on /alerts', () => {
    assert.equal(dockView('/alerts'), 'alerts')
    const overlay = readFileSync(new URL('../src/alerts/AlertsApp.tsx', import.meta.url), 'utf8')
    assert.equal(overlay.includes('AlertDesigner'), false)
    const html = renderToStaticMarkup(createElement(AlertLookView, {
      event: { id: 'a', platform: 'Twitch', kind: 'follow', user: 'Ada', time: '2026-01-01T12:00:00.000Z' },
      settings: parseAlertSettings({ enabled: true, looks: { default: { image: IMAGE, textBoxes: [{ text: '{name}', x: 8, y: 40 }] } } }),
      look: { image: IMAGE, textBoxes: [{ text: '{name}', x: 8, y: 40 }] },
    }))
    assert.match(html, /font-size:8em/)
  })
})
