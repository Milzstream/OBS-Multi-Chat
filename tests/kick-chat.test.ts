import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  kickBadges,
  kickChannelPollFailure,
  looksLikePlaceholder,
  shouldWarnKickChatDown,
} from '../server/logic.js'
import { chatroomIdFrom, createFlushLock, dropSocket, isKickSlug, kickAvatarFromSender, kickChannelPowershell, kickEventToActivity, kickEventToModeration, kickPageFetch, kickProfilePicFromChannel, kickRealtimePlan, kickRealtimeToken, kickSocketShouldStay, parseJson, parseKickChatMessage, pickName, readKickCentrifugoFrame, readKickSocketFrame } from '../server/kick-chat.js'

describe('Kick chat and activity', () => {
  it('treats a non-OK Kick status response as a failed check, not as offline', () => {
    assert.equal(kickChannelPollFailure(200), undefined)
    assert.equal(kickChannelPollFailure(401)?.refresh, true)
    assert.match(kickChannelPollFailure(500)?.message || '', /500/)
    assert.equal(kickChannelPollFailure(500)?.refresh, false)
  })

  it('does not warn that Kick chat is down until a connect attempt has failed', () => {
    assert.equal(shouldWarnKickChatDown(false, false), false)
    assert.equal(shouldWarnKickChatDown(true, false), false)
    assert.equal(shouldWarnKickChatDown(true, true), false)
    assert.equal(shouldWarnKickChatDown(false, true), true)
  })

  it('reads chatroom ids and names from mixed payloads', () => {
    assert.equal(chatroomIdFrom({ chatroom: { id: '44' } }), 44)
    assert.equal(chatroomIdFrom({ data: { chatroom: { id: 0 } } }), undefined)
    assert.equal(pickName({ username: 'Ada' }), 'Ada')
    assert.equal(parseJson('{"ok":true}').ok, true)
    assert.equal(parseJson('{nope}'), undefined)
  })

  it('times out a hung Kick page fetch', async () => {
    await assert.rejects(
      kickPageFetch('https://kick.com/api/v2/channels/ada', {}, (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }), 40),
      /Request timed out after 40ms/,
    )
  })

  it('uses Kick realtime credentials instead of the retired Pusher app', () => {
    const plan = kickRealtimePlan({ data: { connections: [{ provider: 'centrifugo', credentials: { url: 'wss://realtime.example/connection/websocket' } }] } })
    assert.equal(plan?.provider, 'centrifugo')
    assert.equal(plan && 'url' in plan ? plan.url : '', 'wss://realtime.example/connection/websocket')
    const pusher = kickRealtimePlan({ data: { connections: [{ provider: 'pusher', credentials: { app_key: 'abc', cluster: 'us2' } }] } })
    assert.equal(pusher?.provider, 'pusher')
    assert.match(pusher && 'url' in pusher ? pusher.url : '', /ws-us2\.pusher\.com\/app\/abc/)
    assert.equal(kickRealtimeToken({ data: { token: 'jwt' } }), 'jwt')
    assert.equal(readKickCentrifugoFrame('{}')?.kind, 'ping')
    assert.equal(readKickCentrifugoFrame('{"id":1,"connect":{}}')?.kind, 'connected')
    assert.equal(readKickCentrifugoFrame('{"id":2,"subscribe":{}}')?.kind, 'subscribed')
    const publication = readKickCentrifugoFrame(JSON.stringify({ push: { channel: 'chatrooms.44.v2', pub: { data: { event: 'App\\Events\\ChatMessageEvent', data: { id: 'm1', content: 'hi', sender: { username: 'Ada' } } } } } }))
    assert.equal(publication?.kind, 'publication')
    if (publication?.kind === 'publication') assert.equal(readKickSocketFrame(publication.frame)?.message?.user, 'Ada')
    assert.equal(readKickSocketFrame({ event: 'pusher:error', data: '{"code":4001,"message":"not in this cluster"}' })?.handshake, 'error')
  })

  it('drops a stuck socket before the next one opens, and does not replace one that is still connecting', () => {
    const calls: string[] = []
    dropSocket({
      removeAllListeners: (event) => { calls.push(`remove:${event}`) },
      on: (event) => { calls.push(`on:${event}`) },
      terminate: () => { calls.push('terminate') },
    })
    assert.deepEqual(calls, ['remove:message', 'remove:close', 'on:error', 'terminate'])
    dropSocket(undefined)
    assert.equal(kickSocketShouldStay(0), true)
    assert.equal(kickSocketShouldStay(1), true)
    assert.equal(kickSocketShouldStay(2), false)
    assert.equal(kickSocketShouldStay(undefined), false)
  })

  it('runs one avatar flush at a time and replays the in-flight task if another call arrives', async () => {
    const lock = createFlushLock()
    let runs = 0
    let release: () => void = () => undefined
    const done = lock.run(() => new Promise((resolve) => {
      runs += 1
      if (runs === 1) release = () => resolve()
      else resolve()
    }))
    const overlap = lock.run(async () => { runs += 100 })
    assert.equal(runs, 1)
    release()
    await done
    await overlap
    assert.equal(runs, 2)
  })

  it('maps follows, subs, gifts, kicks, and raids', () => {
    assert.equal(kickEventToActivity('FollowEvent', { username: 'Ada' })?.kind, 'follow')
    assert.equal(kickEventToActivity('SubscriptionEvent', { username: 'Ada', months: 3 })?.months, 3)
    assert.equal(kickEventToActivity('GiftedSubscriptionsEvent', { gifter: 'Pat', gifted_usernames: ['a', 'b'] })?.amount, '2 gifts')
    assert.equal(kickEventToActivity('KicksGifted', { username: 'Mel', amount: 100, message: 'yo' })?.amount, '100 Kicks')
    assert.equal(kickEventToActivity('StreamHost', { username: 'Host', viewers: 12 })?.kind, 'raid')
    assert.equal(kickEventToActivity('FollowersUpdated', {}), undefined)
    assert.equal(kickEventToActivity('FollowEvent', { username: 'Ada', slug: 'ada-live' })?.slug, 'ada-live')
  })

  it('maps Kick delete, ban, and unban socket events', () => {
    assert.deepEqual(kickEventToModeration('App\\Events\\MessageDeletedEvent', { id: 'm1' }), { action: 'delete', messageId: 'm1' })
    assert.equal(kickEventToModeration('ChatMessageEvent', { id: 'm1', sender: { username: 'Ada' } }), undefined)
    const banned = kickEventToModeration('UserBannedEvent', { user: { id: 9, username: 'Ada', slug: 'ada' } })
    assert.equal(banned?.action, 'ban')
    assert.equal(banned?.userId, '9')
    assert.equal(kickEventToModeration('UserUnbannedEvent', { user: { id: 9, username: 'Ada' } })?.action, 'unban')
  })

  it('reads Kick avatars from string, nested url, or channel payloads, and leaves typical chat events without one', () => {
    assert.equal(kickAvatarFromSender({ profile_picture: 'https://files.kick.com/a.webp' }), 'https://files.kick.com/a.webp')
    assert.equal(kickAvatarFromSender({ identity: { color: '#fff', profile_pic: { url: 'https://files.kick.com/b.webp' } } }), 'https://files.kick.com/b.webp')
    assert.equal(kickAvatarFromSender({ identity: { color: '#fff', badges: [] } }), undefined)
    assert.equal(kickProfilePicFromChannel({ user: { profilepic: 'https://files.kick.com/c.webp' } }), 'https://files.kick.com/c.webp')
    assert.equal(kickProfilePicFromChannel({ user: { profile_pic: 'https://files.kick.com/images/user/1/profile_image/conversion/x-fullsize.webp' } }), 'https://files.kick.com/images/user/1/profile_image/conversion/x-fullsize.webp')
    const parsed = parseKickChatMessage({
      id: 'm1',
      content: 'hello',
      sender: { id: 9, username: 'Ada', slug: 'ada', identity: { color: '#0f0', badges: [] } },
    })
    assert.equal(parsed?.user, 'Ada')
    assert.equal(parsed?.slug, 'ada')
    assert.equal(parsed?.avatar, undefined)
    assert.equal(parseKickChatMessage({ sender: { username: 'Ada' } }), undefined)
    assert.equal(isKickSlug('milzstream'), true)
    assert.equal(isKickSlug("x'; calc"), false)
    assert.ok(kickChannelPowershell('milzstream')?.args.some((arg) => arg.includes('https://kick.com/api/v2/channels/milzstream')))
    assert.equal(kickChannelPowershell("bad slug"), undefined)
  })

  it('maps Kick badges and placeholder handles', () => {
    assert.deepEqual(kickBadges([{ type: 'broadcaster', text: 'Host' }, { type: 'moderator' }]).map((badge) => badge.label), ['HOST', 'MOD'])
    assert.equal(looksLikePlaceholder('Kick account'), true)
    assert.equal(looksLikePlaceholder('Ada Live'), true)
    assert.equal(looksLikePlaceholder('adalive'), false)
  })
})
