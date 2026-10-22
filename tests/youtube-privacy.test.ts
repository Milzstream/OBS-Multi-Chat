import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  nextYoutubePrivacyWatch,
  youtubePrivacyMessage,
  youtubePrivacyNotices,
  youtubePrivacyRecheckIds,
  youtubePublicVideoBody,
} from '../server/logic.js'

describe('YouTube privacy warnings', () => {
  it('warns for unlisted and private broadcasts and skips public ones', () => {
    const notices = youtubePrivacyNotices([
      { videoId: 'abcdefghijk', title: 'Horizontal', privacyStatus: 'public' },
      { videoId: 'shortsid123', title: 'Vertical', privacyStatus: 'unlisted' },
      { videoId: 'privatesid1', title: '', privacyStatus: 'private' },
      { videoId: 'not-an-id', privacyStatus: 'unlisted' },
    ])
    assert.deepEqual(notices, [
      { videoId: 'shortsid123', title: 'Vertical', privacy: 'unlisted' },
      { videoId: 'privatesid1', title: 'privatesid1', privacy: 'private' },
    ])
    assert.equal(youtubePrivacyMessage(notices[0]), 'YouTube “Vertical” is unlisted.')
  })

  it('keeps ended broadcasts on the watch list and rechecks them after the interval', () => {
    const now = 1_000_000
    const watched = nextYoutubePrivacyWatch(now, [], [{ videoId: 'abcdefghijk', title: 'Horizontal' }])
    assert.equal(watched[0].until, now + 30 * 60_000)
    assert.deepEqual(youtubePrivacyRecheckIds(now, 0, watched, ['abcdefghijk']), [])
    assert.deepEqual(youtubePrivacyRecheckIds(now + 60_000, now, watched, []), [])
    assert.deepEqual(youtubePrivacyRecheckIds(now + 3 * 60_000, now, watched, []), ['abcdefghijk'])
    const kept = nextYoutubePrivacyWatch(now + 31 * 60_000, watched, [])
    assert.deepEqual(kept, [])
  })

  it('sends public privacy and keeps made-for-kids when YouTube already listed it', () => {
    assert.deepEqual(youtubePublicVideoBody('abcdefghijk', { madeForKids: false, privacyStatus: 'unlisted' }), {
      id: 'abcdefghijk',
      status: { privacyStatus: 'public', madeForKids: false },
    })
  })
})
