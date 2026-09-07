import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express from 'express'
import {
  authorizeLocalControl,
  browserOpenPlan,
  createControlGuard,
  createOpenHandler,
  isSafeExternalUrl,
  parseOpenUrl,
  resolveBindHost,
} from '../server/local-api.js'
import { createOAuthStateStore } from '../server/oauth-state.js'

async function listen(app: express.Express) {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

describe('local control authorization', () => {
  const options = { port: 4173, bindHost: '127.0.0.1', lanEnabled: false }

  it('binds to loopback unless LAN mode is opted in', () => {
    assert.deepEqual(resolveBindHost({}), { host: '127.0.0.1', lanEnabled: false })
    assert.deepEqual(resolveBindHost({ RELAY_BIND: '0.0.0.0' }), { host: '0.0.0.0', lanEnabled: true })
    assert.deepEqual(resolveBindHost({ RELAY_LAN: '1' }), { host: '0.0.0.0', lanEnabled: true })
  })

  it('blocks cross-origin control even from loopback', () => {
    const result = authorizeLocalControl({
      method: 'POST',
      path: '/api/messages',
      ip: '127.0.0.1',
      origin: 'https://evil.example',
    }, options)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 403)
  })

  it('allows same-origin loopback docks and token-authenticated LAN tools', () => {
    assert.equal(authorizeLocalControl({
      method: 'POST',
      path: '/api/settings',
      ip: '127.0.0.1',
      origin: 'http://127.0.0.1:4173',
    }, options).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'POST',
      path: '/api/settings',
      ip: '192.168.1.20',
    }, { ...options, bindHost: '0.0.0.0', lanEnabled: true, apiToken: 'secret' }).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'POST',
      path: '/api/settings',
      ip: '192.168.1.20',
      token: 'secret',
    }, { ...options, bindHost: '0.0.0.0', lanEnabled: true, apiToken: 'secret' }).ok, true)
  })
})

describe('profile URL allowlist and Windows open args', () => {
  it('accepts platform profile URLs and rejects everything else', () => {
    assert.equal(isSafeExternalUrl('https://www.twitch.tv/Ada'), true)
    assert.equal(isSafeExternalUrl('https://kick.com/ada'), true)
    assert.equal(isSafeExternalUrl('https://www.youtube.com/@Ada'), true)
    assert.equal(isSafeExternalUrl('https://www.youtube.com/channel/UC1234567890123456789012'), true)
    assert.equal(isSafeExternalUrl('http://www.twitch.tv/Ada'), false)
    assert.equal(isSafeExternalUrl('https://www.twitch.tv/Ada&calc'), false)
    assert.equal(isSafeExternalUrl('https://evil.example/Ada'), false)
    assert.equal(isSafeExternalUrl('https://www.twitch.tv.evil.example/Ada'), false)
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
    assert.equal(parseOpenUrl('https://example.com').ok, false)
  })

  it('opens Windows URLs through rundll32 without a cmd shell string', () => {
    const plan = browserOpenPlan('https://www.twitch.tv/Ada&whoami', 'win32', { SystemRoot: 'C:\\Windows' })
    assert.match(plan.command, /rundll32\.exe$/i)
    assert.deepEqual(plan.args, ['url.dll,FileProtocolHandler', 'https://www.twitch.tv/Ada&whoami'])
    assert.equal((plan.options as { windowsHide?: boolean }).windowsHide, true)
  })
})

describe('OAuth pending state', () => {
  it('expires old entries and caps the pending map', () => {
    let now = 1_000_000
    const store = createOAuthStateStore({ ttlMs: 1_000, max: 3, now: () => now })
    store.set('a', { platform: 'Twitch', createdAt: now })
    store.set('b', { platform: 'Kick', createdAt: now })
    store.set('c', { platform: 'YouTube', createdAt: now })
    store.set('d', { platform: 'Twitch', createdAt: now })
    assert.equal(store.size(), 3)
    assert.equal(store.get('a'), undefined)
    assert.equal(store.get('d')?.platform, 'Twitch')
    now += 2_000
    assert.equal(store.get('d'), undefined)
    assert.equal(store.size(), 0)
  })
})

describe('control HTTP harness', () => {
  it('rejects unauthorized control posts, unsafe open URLs, and expired OAuth state', async () => {
    const opened: string[] = []
    const oauth = createOAuthStateStore({ ttlMs: 30_000, max: 8 })
    oauth.set('fresh', { platform: 'Twitch', createdAt: Date.now() })
    oauth.set('stale', { platform: 'Kick', createdAt: Date.now() - 60_000 })
    const localApi: { port: number; bindHost: string; lanEnabled: boolean } = { port: 4173, bindHost: '127.0.0.1', lanEnabled: false }
    const app = express()
    app.use(express.json())
    app.use(createControlGuard(localApi))
    app.post('/api/open', createOpenHandler((url) => opened.push(url)))
    app.post('/api/settings', (_request, response) => response.json({ ok: true }))
    app.get('/oauth/callback', (request, response) => {
      const pending = oauth.get(String(request.query.state || ''))
      if (!pending) return response.status(400).send('OAuth callback is missing a valid state or code.')
      oauth.delete(String(request.query.state || ''))
      response.send('ok')
    })
    const server = await listen(app)
    localApi.port = server.port
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const denied = await fetch(`${server.url}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ dropOldAlerts: true }),
      })
      assert.equal(denied.status, 403)

      const allowed = await fetch(`${server.url}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ dropOldAlerts: true }),
      })
      assert.equal(allowed.status, 200)

      const unsafe = await fetch(`${server.url}/api/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
      assert.equal(unsafe.status, 400)

      const safe = await fetch(`${server.url}/api/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ url: 'https://www.twitch.tv/Ada' }),
      })
      assert.equal(safe.status, 200)
      assert.deepEqual(opened, ['https://www.twitch.tv/Ada'])

      const stale = await fetch(`${server.url}/oauth/callback?state=stale&code=1`)
      assert.equal(stale.status, 400)
      const fresh = await fetch(`${server.url}/oauth/callback?state=fresh&code=1`)
      assert.equal(fresh.status, 200)
    } finally {
      await server.close()
    }
  })
})
