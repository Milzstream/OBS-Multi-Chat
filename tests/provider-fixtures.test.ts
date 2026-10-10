import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readKickSocketFrame } from '../server/kick-chat.js'
import { kickBadges, parseKickParts } from '../server/logic.js'
import { extractSession, extractVideoId, nextContinuation, parseActions, parseModerationActions, parseYouTubeTitle, parseYouTubeViewers } from '../server/youtube-chat.js'

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

type Fixture = {
  name: string
  path: string
  kind?: string
  raw?: string
  frame?: unknown
  html?: string
  payload?: unknown
  videoId?: string
  expect: unknown
}

function loadFixtures(dir: string): Fixture[] {
  return readdirSync(path.join(fixtureRoot, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name)
      const parsed = JSON.parse(readFileSync(path.join(fixtureRoot, file), 'utf8')) as Fixture
      return { ...parsed, path: `tests/fixtures/${file.replaceAll('\\', '/')}` }
    })
}

function mismatches(actual: unknown, expected: unknown, at = ''): string[] {
  if (expected === null) return actual == null ? [] : [`${at}: expected null, got ${JSON.stringify(actual)}`]
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected array, got ${JSON.stringify(actual)}`]
    const lines = expected.flatMap((item, index) => mismatches(actual[index], item, `${at}[${index}]`))
    if (actual.length !== expected.length) lines.push(`${at}.length: expected ${expected.length}, got ${actual.length}`)
    return lines
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return [`${at}: expected object, got ${JSON.stringify(actual)}`]
    return Object.entries(expected).flatMap(([key, value]) => mismatches((actual as Record<string, unknown>)[key], value, at ? `${at}.${key}` : key))
  }
  if (actual !== expected) return [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`]
  return []
}

function assertFixture(file: string, actual: unknown, expected: unknown) {
  const lines = mismatches(actual, expected)
  assert.equal(lines.length, 0, [
    `${file} no longer matches the reader.`,
    'Update that fixture if the provider changed this payload, or fix the parser if the fixture is still valid.',
    ...lines,
  ].join('\n'))
}

function kickView(frame: ReturnType<typeof readKickSocketFrame>) {
  if (!frame) return null
  const message = frame.message
  return {
    handshake: frame.handshake ?? null,
    message: message ? {
      id: message.id ?? null,
      user: message.user,
      text: message.text,
      userId: message.userId ?? null,
      slug: message.slug ?? null,
      color: message.color ?? null,
      avatar: message.avatar ?? null,
      badges: kickBadges(message.badges).map((badge) => badge.label),
      parts: parseKickParts(message.text, message.emotes).map((part) => part.type === 'emote' ? { type: part.type, name: part.name } : { type: part.type, text: part.text }),
    } : null,
    moderation: frame.moderation ?? null,
    activity: frame.activity ? {
      kind: frame.activity.kind,
      user: frame.activity.user,
      slug: frame.activity.slug ?? null,
      months: frame.activity.months ?? null,
      amount: frame.activity.amount ?? null,
      viewers: frame.activity.viewers ?? null,
      message: frame.activity.message ?? null,
      time: frame.activity.time ?? null,
    } : null,
  }
}

function watchView(html: string) {
  const session = extractSession(html, 'fallback0001')
  return {
    session: session ? {
      videoId: session.videoId,
      apiKey: session.apiKey,
      clientVersion: session.clientVersion,
      continuation: session.continuation,
      visitorData: session.visitorData ?? null,
    } : null,
    videoId: extractVideoId(html) ?? null,
    viewers: parseYouTubeViewers(html) ?? null,
    title: parseYouTubeTitle(html) ?? null,
  }
}

function chatView(payload: unknown, videoId: string) {
  const continuation = nextContinuation(payload)
  return {
    messages: parseActions(payload, videoId).map((message) => ({
      user: message.user,
      text: message.text,
      userId: message.userId ?? null,
      activityKind: message.activityKind ?? null,
      amount: message.amount ?? null,
      badges: (message.badges || []).map((badge) => badge.label),
    })),
    moderation: parseModerationActions(payload),
    continuation: { continuation: continuation.continuation ?? null, ended: continuation.ended },
  }
}

describe('Kick socket fixtures', () => {
  for (const fixture of loadFixtures('kick')) {
    it(fixture.name, () => {
      const frame = fixture.raw !== undefined ? readKickSocketFrame(fixture.raw) : readKickSocketFrame(JSON.stringify(fixture.frame))
      assertFixture(fixture.path, kickView(frame), fixture.expect)
    })
  }
})

describe('YouTube watch and InnerTube fixtures', () => {
  for (const fixture of loadFixtures('youtube')) {
    it(fixture.name, () => {
      if (fixture.kind === 'watch') {
        assertFixture(fixture.path, watchView(fixture.html || ''), fixture.expect)
        return
      }
      assertFixture(fixture.path, chatView(fixture.payload, fixture.videoId || 'fallback0001'), fixture.expect)
    })
  }
})
