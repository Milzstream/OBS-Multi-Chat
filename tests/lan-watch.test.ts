import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express from 'express'
import { dockView } from '../src/dock-view.ts'
import {
  authorizeLocalControl,
  classifyAccess,
  createControlGuard,
  lanWatchUrl,
  listenHostFor,
  pickLanIPv4,
  resolveWatchSecret,
  watchLogLine,
  watchTokenFromRequest,
  watchUrlForLog,
} from '../server/local-api.js'

const lan = { port: 4173, bindHost: '0.0.0.0', lanEnabled: true, apiToken: 'write-secret', watchToken: 'view-secret' }

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

describe('LAN watch access', () => {
  it('classifies operator pages, secrets, and the watch reads', () => {
    assert.equal(classifyAccess('GET', '/api/jwts'), 'secret')
    assert.equal(classifyAccess('POST', '/api/jwts'), 'write')
    assert.equal(classifyAccess('GET', '/api/state'), 'read')
    assert.equal(classifyAccess('GET', '/events'), 'read')
    assert.equal(classifyAccess('GET', '/watch'), 'read')
    assert.equal(classifyAccess('GET', '/'), 'operator')
    assert.equal(classifyAccess('GET', '/activity'), 'operator')
    assert.equal(classifyAccess('GET', '/console'), 'operator')
    assert.equal(classifyAccess('POST', '/api/shutdown'), 'operator')
    assert.equal(classifyAccess('POST', '/api/console/bye'), 'operator')
    assert.equal(classifyAccess('GET', '/oauth/callback'), 'oauth')
    assert.equal(classifyAccess('GET', '/assets/index.js'), 'public')
  })

  it('does not let a forged Origin or the watch token write', () => {
    const forged = authorizeLocalControl({
      method: 'POST',
      path: '/api/messages',
      ip: '192.168.1.20',
      origin: 'http://192.168.1.20:4173',
      host: '192.168.1.20:4173',
      watchToken: 'view-secret',
    }, lan)
    assert.equal(forged.ok, false)
    if (!forged.ok) assert.equal(forged.error, 'LAN control requests require RELAY_API_TOKEN')

    assert.equal(authorizeLocalControl({
      method: 'POST',
      path: '/api/moderate',
      ip: '192.168.1.20',
      token: 'write-secret',
    }, lan).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/api/jwts',
      ip: '192.168.1.20',
      watchToken: 'view-secret',
    }, lan).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/api/jwts',
      ip: '192.168.1.20',
      token: 'write-secret',
    }, lan).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/api/state',
      ip: '192.168.1.20',
      watchToken: 'view-secret',
      watchTokenFrom: 'query',
    }, lan).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'POST',
      path: '/api/shutdown',
      ip: '192.168.1.20',
      token: 'write-secret',
    }, lan).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/oauth/callback',
      ip: '192.168.1.20',
    }, lan).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/oauth/twitch',
      ip: '192.168.1.20',
      token: 'write-secret',
    }, lan).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/',
      ip: '192.168.1.20',
      watchToken: 'view-secret',
    }, lan).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/api/jwts',
      ip: '127.0.0.1',
    }, lan).ok, true)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/assets/index.js',
      ip: '192.168.1.20',
    }, { ...lan, lanEnabled: false }).ok, false)
    assert.equal(authorizeLocalControl({
      method: 'GET',
      path: '/',
      ip: '192.168.1.20',
    }, { ...lan, lanEnabled: true, watchToken: 'view-secret' }).ok, false)
  })

  it('keeps a view token that is not the write secret', () => {
    assert.deepEqual(resolveWatchSecret({ lanEnabled: false, create: () => 'generated-token-value' }), {})
    assert.equal(resolveWatchSecret({ lanEnabled: true, envToken: 'short' }).warning?.includes('ignored'), true)
    const kept = resolveWatchSecret({
      lanEnabled: true,
      envToken: 'write-secret',
      apiToken: 'write-secret',
      stored: 'stored-view-token',
    })
    assert.equal(kept.token, 'stored-view-token')
    assert.match(kept.warning || '', /matches RELAY_API_TOKEN/)
    const created = resolveWatchSecret({ lanEnabled: true, stored: 'nope', create: () => 'generated-view-token' })
    assert.equal(created.token, 'generated-view-token')
    assert.equal(created.persist, 'generated-view-token')
    assert.equal(watchTokenFromRequest('from-query', `${'relay_watch'}=from-cookie`)?.token, 'from-query')
    assert.equal(watchTokenFromRequest(undefined, 'relay_watch=from-cookie')?.from, 'cookie')
  })

  it('builds a stable private watch URL', () => {
    const interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth: [
        { address: '10.0.0.8', family: 'IPv4', internal: false },
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: '169.254.1.1', family: 'IPv4', internal: false },
      ],
    }
    assert.equal(pickLanIPv4('0.0.0.0', interfaces), '192.168.1.20')
    assert.equal(pickLanIPv4('10.1.1.1', interfaces), '10.1.1.1')
    assert.equal(lanWatchUrl({ bindHost: '0.0.0.0', port: 4173, token: 'view-secret', interfaces }), 'http://192.168.1.20:4173/watch?token=view-secret')
    assert.equal(watchUrlForLog('http://192.168.1.20:4173/watch?token=view-secret'), 'http://192.168.1.20:4173/watch')
    assert.equal(watchLogLine('http://192.168.1.20:4173/watch?token=view-secret'), 'Watch          http://192.168.1.20:4173/watch')
    assert.equal(watchLogLine(undefined), 'Watch is on, but no private IPv4 address was found for a watch link.')
    assert.equal(listenHostFor(false, '0.0.0.0'), '0.0.0.0')
    assert.equal(listenHostFor(true, '0.0.0.0'), '0.0.0.0')
    assert.equal(listenHostFor(false), '127.0.0.1')
    assert.equal(listenHostFor(true), '0.0.0.0')
  })

  it('mounts /watch instead of the operator docks', () => {
    assert.equal(dockView('/watch', '?view=activity'), 'watch')
    assert.equal(dockView('/watch/', ''), 'watch')
    assert.equal(dockView('/activity', ''), 'activity')
    assert.equal(dockView('/', '?view=activity'), 'activity')
    assert.equal(dockView('/console', ''), 'companion')
    assert.equal(dockView('/', ''), 'chat')
    const source = readFileSync(new URL('../src/WatchApp.tsx', import.meta.url), 'utf8')
    assert.equal(source.includes('openDockUrl'), false)
    assert.equal(/fetch\(\s*['"]\/api\/(?:open|messages|moderate|settings|shutdown)/.test(source), false)
    assert.equal(source.includes('openIn="browser"'), true)
  })

  it('rejects a LAN JWT read and a forged-origin write, and accepts the watch token for state', async () => {
    const options = { ...lan, peerAddress: () => '192.168.1.20' }
    const app = express()
    app.use(express.json())
    app.use(createControlGuard(options))
    app.get('/api/jwts', (_request, response) => response.json({ Twitch: 'jwt' }))
    app.get('/api/state', (_request, response) => response.json({ ok: true }))
    app.get('/events', (_request, response) => response.type('text/event-stream').end('ok'))
    app.post('/api/messages', (_request, response) => response.json({ ok: true }))
    app.post('/api/shutdown', (_request, response) => response.json({ ok: true }))
    app.get('/oauth/callback', (_request, response) => response.send('exchanged'))
    app.get('/watch', (_request, response) => response.type('html').send('watch'))
    app.get('/', (_request, response) => response.type('html').send('dock'))
    const server = await listen(app)
    options.port = server.port
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const jwts = await fetch(`${server.url}/api/jwts`)
      assert.equal(jwts.status, 403)
      const jwtsWatch = await fetch(`${server.url}/api/jwts?token=view-secret`)
      assert.equal(jwtsWatch.status, 403)
      const jwtsToken = await fetch(`${server.url}/api/jwts`, { headers: { 'x-relay-token': 'write-secret' } })
      assert.equal(jwtsToken.status, 200)

      const forged = await fetch(`${server.url}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ text: 'hi' }),
      })
      assert.equal(forged.status, 403)
      const forgedBody = await forged.json() as { error?: string }
      assert.equal(forgedBody.error, 'LAN control requests require RELAY_API_TOKEN')

      const queryWrite = await fetch(`${server.url}/api/messages?token=write-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ text: 'hi' }),
      })
      assert.equal(queryWrite.status, 403)

      const watchWrite = await fetch(`${server.url}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: 'relay_watch=view-secret' },
        body: JSON.stringify({ text: 'hi' }),
      })
      assert.equal(watchWrite.status, 403)

      const tooled = await fetch(`${server.url}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-token': 'write-secret' },
        body: JSON.stringify({ text: 'hi' }),
      })
      assert.equal(tooled.status, 200)

      const state = await fetch(`${server.url}/api/state`)
      assert.equal(state.status, 403)
      const stateWatch = await fetch(`${server.url}/api/state?token=view-secret`)
      assert.equal(stateWatch.status, 200)
      const cookie = stateWatch.headers.get('set-cookie') || ''
      assert.match(cookie, /relay_watch=/)
      const events = await fetch(`${server.url}/events`, { headers: { Cookie: 'relay_watch=view-secret' } })
      assert.equal(events.status, 200)

      const shutdown = await fetch(`${server.url}/api/shutdown`, { method: 'POST', headers: { 'x-relay-token': 'write-secret' } })
      assert.equal(shutdown.status, 403)
      const oauth = await fetch(`${server.url}/oauth/callback?code=1&state=1`)
      assert.equal(oauth.status, 403)
      const oauthToken = await fetch(`${server.url}/oauth/callback?code=1&state=1`, { headers: { Authorization: 'Bearer write-secret' } })
      assert.equal(oauthToken.status, 200)

      const dock = await fetch(`${server.url}/`)
      assert.equal(dock.status, 403)
      assert.match(await dock.text(), /streaming PC/)
      const watch = await fetch(`${server.url}/watch`)
      assert.equal(watch.status, 403)
      assert.match(await watch.text(), /wrong token/)
      const watchOk = await fetch(`${server.url}/watch?token=view-secret`)
      assert.equal(watchOk.status, 200)
    } finally {
      await server.close()
    }
  })
})
