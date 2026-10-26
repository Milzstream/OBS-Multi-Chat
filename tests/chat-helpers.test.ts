import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyExactCategory, assignTagPlatforms, AVATAR_RETRY_MAX, avatarShowsImage, categoryPickNote, chatProfileUrl, commitTypedCategory, dockAvatarSrc, exactCategoryMatch, kickProfileSlug, mergeCategoryResults, moderationAcceptsReason, moderationNeedsDockConfirm, moderationPlatformLabel, moderationStatus, moderationTargets, nextOptionIndex, platformStatTip, preferredCategory, selectedSendPlatforms, sharedStreamTags, shouldRetryAvatar, streamDashboardUrl, streamTitleTip, tagAssignments, tagPlatforms, unifiedCategoryQuery, visibleChatMessages, youtubeBanConfirmLabel, youtubePrivacyMessage, youtubeStudioUrl } from '../src/chat-helpers.ts'
import { YoutubePrivacyBanner } from '../src/YoutubePrivacyBanner.tsx'

describe('chat dock helpers', () => {
  it('proxies Kick, Twitch, and YouTube CDN avatars through the local media route', () => {
    assert.equal(dockAvatarSrc('https://files.kick.com/images/user/1/a.webp'), '/api/media?u=https%3A%2F%2Ffiles.kick.com%2Fimages%2Fuser%2F1%2Fa.webp')
    assert.equal(dockAvatarSrc('https://static-cdn.jtvnw.net/jtv_user_pictures/x.png'), '/api/media?u=https%3A%2F%2Fstatic-cdn.jtvnw.net%2Fjtv_user_pictures%2Fx.png')
    assert.equal(dockAvatarSrc('https://yt4.ggpht.com/ytc/abc=s88-c-k'), '/api/media?u=https%3A%2F%2Fyt4.ggpht.com%2Fytc%2Fabc%3Ds88-c-k')
    assert.equal(dockAvatarSrc('/api/media?u=https%3A%2F%2Fstatic-cdn.jtvnw.net%2Fx.png'), '/api/media?u=https%3A%2F%2Fstatic-cdn.jtvnw.net%2Fx.png')
    assert.equal(dockAvatarSrc('https://evil.example/a.png'), 'https://evil.example/a.png')
    assert.equal(dockAvatarSrc(undefined), undefined)
  })

  it('shows an avatar until that exact src fails, then retries a couple of times', () => {
    const src = '/api/media?u=https%3A%2F%2Fstatic-cdn.jtvnw.net%2Fx.png'
    assert.equal(avatarShowsImage(undefined, undefined), false)
    assert.equal(avatarShowsImage(src, undefined), true)
    assert.equal(avatarShowsImage(src, src), false)
    assert.equal(avatarShowsImage('/api/media?u=https%3A%2F%2Fstatic-cdn.jtvnw.net%2Fy.png', src), true)
    assert.equal(shouldRetryAvatar(src, src, 0), true)
    assert.equal(shouldRetryAvatar(src, src, AVATAR_RETRY_MAX - 1), true)
    assert.equal(shouldRetryAvatar(src, src, AVATAR_RETRY_MAX), false)
    assert.equal(shouldRetryAvatar(src, undefined, 0), false)
    assert.equal(shouldRetryAvatar(undefined, undefined, 0), false)
  })

  it('uses a Kick slug when present and otherwise converts underscores', () => {
    assert.equal(kickProfileSlug('SuperIOgame_Tyle88', 'superiogame-tyle88'), 'superiogame-tyle88')
    assert.equal(kickProfileSlug('SuperIOgame_Tyle88'), 'superiogame-tyle88')
  })

  it('prefers the longer category name when both platforms have one', () => {
    assert.equal(preferredCategory('Just Chatting', 'Just Chatting (IRL)'), 'Just Chatting (IRL)')
    assert.equal(preferredCategory('', 'Kick Game'), 'Kick Game')
    assert.equal(preferredCategory('Twitch Game', ''), 'Twitch Game')
    assert.equal(unifiedCategoryQuery('Valorant', 'Valorant', 'Just Chatting (IRL)', false), 'Valorant')
    assert.equal(unifiedCategoryQuery('Old', 'Minecraft', 'Minecraft', false), 'Minecraft')
  })

  it('filters messages by platform including merged multi-platform rows', () => {
    const messages = [
      { id: '1', platform: 'Twitch' as const, text: 'a' },
      { id: '2', platform: 'YouTube' as const, platforms: ['Twitch', 'YouTube'] as const, text: 'b' },
      { id: '3', platform: 'Kick' as const, text: 'c' },
    ]
    assert.equal(visibleChatMessages(messages, 'All').length, 3)
    assert.deepEqual(visibleChatMessages(messages, 'YouTube').map((item) => item.id), ['2'])
    assert.deepEqual(visibleChatMessages(messages, 'Twitch').map((item) => item.id), ['1', '2'])
  })

  it('selects connected send destinations and honors opt-out', () => {
    assert.deepEqual(selectedSendPlatforms(['Twitch', 'YouTube']), ['Twitch', 'YouTube'])
    assert.deepEqual(selectedSendPlatforms(['Twitch', 'Kick', 'YouTube'], ['YouTube']), ['Twitch', 'Kick'])
    assert.deepEqual(selectedSendPlatforms([]), [])
  })

  it('clamps category-list highlight and does not wrap', () => {
    assert.equal(nextOptionIndex(0, 8, 1), 1)
    assert.equal(nextOptionIndex(7, 8, 1), 7)
    assert.equal(nextOptionIndex(0, 8, -1), 0)
    assert.equal(nextOptionIndex(3, 0, 1), 0)
  })

  it('opens the channel-scoped Twitch viewer card and the YouTube channel page', () => {
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada' }, 'Milz'), 'https://www.twitch.tv/popout/milz/viewercard/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada Lovelace', handle: 'ada' }, 'Milz'), 'https://www.twitch.tv/popout/milz/viewercard/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada' }), 'https://www.twitch.tv/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'not a login' }), undefined)
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'TestUser' }), undefined)
    assert.equal(chatProfileUrl({ platform: 'Kick', user: 'SuperIOgame_Tyle88', handle: 'superiogame-tyle88' }), 'https://kick.com/superiogame-tyle88')
    assert.equal(chatProfileUrl({ platform: 'YouTube', user: 'Ada', userId: 'UC1234567890123456789012' }), 'https://www.youtube.com/channel/UC1234567890123456789012')
    assert.equal(chatProfileUrl({ platform: 'YouTube', user: '@Ada' }), 'https://www.youtube.com/@ada')
    assert.equal(moderationAcceptsReason('Twitch'), true)
    assert.equal(moderationAcceptsReason('Kick'), true)
    assert.equal(moderationAcceptsReason('YouTube'), false)
    assert.equal(moderationStatus('ban', 'Ada', 'spam'), 'Banned Ada: spam')
    assert.equal(moderationStatus('timeout', 'Ada'), 'Timed out Ada')
    assert.equal(moderationStatus('ban', 'Ada', '  '), 'Banned Ada')
    assert.equal(youtubePrivacyMessage({ title: 'Night stream', privacy: 'unlisted' }), 'YouTube “Night stream” is unlisted.')
  })

  it('lists every YouTube live title on the tile tooltip, and Twitch or Kick show theirs', () => {
    assert.equal(platformStatTip({ platform: 'Twitch', live: true, connected: true, viewers: 12, title: 'Night stream' }), 'Twitch · live\nNight stream\n12 viewers\nConnected\nOpen Twitch dashboard')
    assert.equal(platformStatTip({ platform: 'Kick', live: true, connected: true, viewers: 3, title: 'Just chatting' }), 'Kick · live\nJust chatting\n3 viewers\nConnected\nOpen Kick dashboard')
    assert.equal(platformStatTip({ platform: 'YouTube', live: true, connected: true, viewers: 9, streams: [{ title: 'Only one', viewers: 9 }] }), 'YouTube · live\nOnly one\n9 viewers\nConnected\nOpen YouTube dashboard')
    assert.equal(platformStatTip({ platform: 'YouTube', live: true, connected: true, viewers: 16, streams: [{ title: 'Horizontal', viewers: 12 }, { title: 'Late night', label: 'Shorts', viewers: 4 }] }), 'YouTube · live\nHorizontal · 12 viewers\nShorts: Late night · 4 viewers\n16 combined viewers\nConnected\nOpen YouTube dashboard')
  })

  it('keeps the full broadcast title on the privacy warning for hover, and clips the line', () => {
    const title = 'A scheduled title that is longer than the dock'
    const html = renderToStaticMarkup(createElement(YoutubePrivacyBanner, {
      notice: { videoId: 'abcdefghijk', title, privacy: 'unlisted' },
      className: 'health-banner warn youtube-privacy',
      onPublic: () => undefined,
      onDismiss: () => undefined,
    }))
    assert.match(html, /class="youtube-privacy-text"/)
    assert.match(html, /title="A scheduled title that is longer than the dock"/)
    assert.match(html, /YouTube “A scheduled title that is longer than the dock” is unlisted\./)
    const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.youtube-privacy-text \{[^}]*text-overflow: ellipsis/)
  })

  it('builds YouTube Studio URLs without inventing a channel path', () => {
    assert.equal(youtubeStudioUrl(), 'https://studio.youtube.com/livestreaming')
    assert.equal(youtubeStudioUrl('UC1234567890123456789012'), 'https://studio.youtube.com/channel/UC1234567890123456789012/livestreaming')
    assert.equal(youtubeStudioUrl('not-a-channel'), 'https://studio.youtube.com/livestreaming')
    assert.equal(streamDashboardUrl('Twitch', { handle: 'Ada' }), 'https://dashboard.twitch.tv/u/ada/stream-manager')
    assert.equal(streamDashboardUrl('Kick', { handle: 'ada' }), 'https://kick.com/dashboard/stream')
    assert.equal(streamDashboardUrl('YouTube', { channelId: 'UC1234567890123456789012' }), 'https://studio.youtube.com/channel/UC1234567890123456789012/livestreaming')
  })

  it('merges Twitch and Kick category hits by name and keeps platform ids', () => {
    const merged = mergeCategoryResults(
      [{ id: 't1', name: 'Just Chatting' }, { id: 't2', name: 'Art' }],
      [{ id: 'k1', name: 'just chatting' }, { id: 'k2', name: 'Music' }],
    )
    assert.equal(merged[0].name, 'Just Chatting')
    assert.equal(merged[0].twitchId, 't1')
    assert.equal(merged[0].kickId, 'k1')
    const art = merged.find((item) => item.name === 'Art')
    assert.equal(art?.twitchId, 't2')
    assert.equal(art?.kickId, undefined)
    const music = merged.find((item) => item.name === 'Music')
    assert.equal(music?.kickId, 'k2')
    assert.equal(music?.twitchId, undefined)
  })

  it('unions tag lists without duplicates', () => {
    assert.deepEqual(sharedStreamTags(['English'], ['english', 'IRL'], ['IRL']), ['English', 'IRL'])
  })

  it('marks which platforms can take a tag', () => {
    assert.deepEqual(tagPlatforms('English'), ['Twitch', 'Kick'])
    assert.deepEqual(tagPlatforms('first-play'), ['Kick'])
    assert.deepEqual(tagPlatforms('こんにちは'), [])
    assert.deepEqual(assignTagPlatforms('English', []), [])
    assert.deepEqual(assignTagPlatforms('first-play', ['Twitch']), [])
    assert.deepEqual(assignTagPlatforms('English', ['Kick']), ['Kick'])
    assert.deepEqual(moderationTargets({ platform: 'Twitch', id: 'm1', copies: [{ platform: 'Twitch', id: 'm1', userId: '1' }, { platform: 'Kick', id: 'm2', userId: '2' }] }).map((item) => item.platform), ['Twitch', 'Kick'])
    assert.equal(moderationPlatformLabel({ platform: 'Twitch', copies: [{ platform: 'Twitch' }, { platform: 'Kick' }] }), 'Twitch, Kick')
  })

  it('builds per-tag platform assignments from the three lists', () => {
    const assigned = tagAssignments(['English'], ['English', 'first-play'])
    const english = assigned.find((item) => item.tag === 'English')
    assert.deepEqual(english?.platforms, ['Twitch', 'Kick'])
    assert.deepEqual(assigned.find((item) => item.tag === 'first-play')?.platforms, ['Kick'])
  })
})

describe('stream category commit', () => {
  it('commits typed text, keeps an exact id, and does not replace a name with a longer near-match', () => {
    assert.equal(exactCategoryMatch('minecraft', [{ id: '1', name: 'Minecraft' }, { id: '2', name: 'Minecraft Dungeons' }])?.id, '1')
    assert.equal(exactCategoryMatch('Mine', [{ id: '2', name: 'Minecraft' }]), undefined)
    const typed = commitTypedCategory({ category: 'Old', categoryId: '9' }, 'Minecraft')
    assert.equal(typed.category, 'Minecraft')
    assert.equal(typed.categoryId, undefined)
    const kept = commitTypedCategory({ category: 'Minecraft', categoryId: '1' }, 'minecraft')
    assert.equal(kept.categoryId, '1')
    const resolved = applyExactCategory({ category: 'Just Chatting', categoryId: undefined }, { id: '3', name: 'Just Chatting (IRL)' })
    assert.equal(resolved.category, 'Just Chatting')
    assert.equal(resolved.categoryId, undefined)
    const exact = applyExactCategory({ category: 'Minecraft' }, { id: '1', name: 'Minecraft' })
    assert.equal(exact.categoryId, '1')
    assert.match(categoryPickNote('Just Chatting', '1', undefined), /Kick was not changed/)
    assert.equal(categoryPickNote('IRL', '1', '2'), '')
    assert.match(streamTitleTip('Friday', 'IRL', ''), /Opens YouTube Studio/)
  })
})

describe('dock moderation confirm', () => {
  it('asks for a YouTube ban in the dock and leaves Twitch on the reason prompt', () => {
    assert.equal(moderationNeedsDockConfirm('ban', ['YouTube'], undefined), true)
    assert.equal(moderationNeedsDockConfirm('ban', ['YouTube'], ''), false)
    assert.equal(moderationNeedsDockConfirm('ban', ['Twitch'], undefined), false)
    assert.equal(moderationNeedsDockConfirm('timeout', ['YouTube'], undefined), false)
    assert.equal(youtubeBanConfirmLabel('Ada', 'YouTube'), 'Ban Ada on YouTube?')
    assert.equal(moderationAcceptsReason('YouTube'), false)
  })
})
