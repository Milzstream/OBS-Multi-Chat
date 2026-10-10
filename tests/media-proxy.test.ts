import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, it } from 'node:test'
import type { FetchLike } from '../server/fetch-timed.js'
import { fetchMedia } from '../server/media-proxy.js'

const SAFE = 'https://files.kick.com/images/user/1/a.webp'

function image(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png', ...headers } })
}

async function fetchMediaWith(fetchImpl: FetchLike, extra: { timeoutMs?: number; maxBytes?: number } = {}) {
  return fetchMedia(SAFE, { fetchImpl, ...extra })
}

async function localMedia(handler: (req: IncomingMessage, res: ServerResponse, sent: () => number) => void) {
  const server = createServer()
  const sockets = new Set<Socket>()
  let bytes = 0
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('request', (req, res) => {
    const write = res.write.bind(res)
    res.write = ((chunk, encoding, callback) => {
      bytes += Buffer.byteLength(chunk)
      return write(chunk, encoding as BufferEncoding, callback as () => void)
    }) as typeof res.write
    handler(req, res, () => bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    sent: () => bytes,
    fetchImpl: ((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      return fetch(`http://127.0.0.1:${port}${path}`, init)
    }) as FetchLike,
    async close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function trickle(res: ServerResponse, total: number) {
  const chunk = Buffer.alloc(32 * 1024, 7)
  let sent = 0
  const write = () => {
    if (res.destroyed || res.writableEnded) return
    if (sent >= total) {
      res.end()
      return
    }
    res.write(chunk)
    sent += chunk.length
    setTimeout(write, 20)
  }
  write()
}

describe('media proxy', () => {
  it('rejects a redirect to a non-allowlisted host without requesting it', { timeout: 2_000 }, async () => {
    const calls: string[] = []
    const upstream = await localMedia((req, res) => {
      if (req.url === '/evil') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end('secret')
        return
      }
      res.writeHead(302, { Location: 'https://evil.example/stolen.png' })
      trickle(res, 1024 * 1024)
    })
    try {
      const result = await fetchMediaWith(async (url, init) => {
        calls.push(url)
        return upstream.fetchImpl(url, init)
      })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.status, 502)
      assert.deepEqual(calls, [SAFE])
      assert.ok(upstream.sent() < 1024 * 1024)
    } finally {
      await upstream.close()
    }
  })

  it('rejects an http redirect and a redirect with no location', async () => {
    const http = await fetchMediaWith(async () => new Response(null, { status: 302, headers: { Location: 'http://files.kick.com/a.png' } }))
    const missing = await fetchMediaWith(async () => new Response(null, { status: 302 }))
    assert.equal(http.ok, false)
    assert.equal(missing.ok, false)
  })

  it('follows an allowlisted redirect and a same-host relative redirect', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const calls: string[] = []
    const followed = await fetchMediaWith(async (url, init) => {
      calls.push(url)
      assert.equal(init?.redirect, 'manual')
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://static-cdn.jtvnw.net/a.png' } })
      return image(png)
    })
    assert.equal(followed.ok, true)
    if (followed.ok) {
      assert.equal(followed.contentType, 'image/png')
      assert.deepEqual([...followed.body], [...png])
    }
    assert.deepEqual(calls, [SAFE, 'https://static-cdn.jtvnw.net/a.png'])

    const relative = await fetchMedia('https://yt3.ggpht.com/a.webp', {
      fetchImpl: async (url) => {
        if (url.endsWith('/a.webp')) return new Response(null, { status: 307, headers: { Location: '/b.png' } })
        assert.equal(url, 'https://yt3.ggpht.com/b.png')
        return new Response(png, { status: 200, headers: { 'Content-Type': 'image/webp; charset=binary' } })
      },
    })
    assert.equal(relative.ok, true)
    if (relative.ok) assert.equal(relative.contentType, 'image/webp')
  })

  it('stops after too many redirects', async () => {
    let calls = 0
    const result = await fetchMediaWith(async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { Location: 'https://files.kick.com/next.webp' } })
    })
    assert.equal(result.ok, false)
    assert.equal(calls, 4)
  })

  it('rejects a non-image response without buffering the body', { timeout: 2_000 }, async () => {
    const total = 1024 * 1024
    const upstream = await localMedia((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      trickle(res, total)
    })
    try {
      const result = await fetchMedia(SAFE, { fetchImpl: upstream.fetchImpl })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.status, 502)
      assert.ok(upstream.sent() < total)
    } finally {
      await upstream.close()
    }
  })

  it('rejects an oversized content-length without buffering the body', { timeout: 2_000 }, async () => {
    const total = 1024 * 1024
    const upstream = await localMedia((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(8 * 1024 * 1024) })
      trickle(res, total)
    })
    try {
      const result = await fetchMedia(SAFE, { fetchImpl: upstream.fetchImpl, maxBytes: 1024 })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.status, 502)
      assert.ok(upstream.sent() < total)
    } finally {
      await upstream.close()
    }
  })

  it('rejects an oversized stream without buffering the whole body', { timeout: 2_000 }, async () => {
    const total = 1024 * 1024
    const upstream = await localMedia((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      trickle(res, total)
    })
    try {
      const result = await fetchMedia(SAFE, { fetchImpl: upstream.fetchImpl, maxBytes: 32 * 1024 })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.status, 502)
      assert.ok(upstream.sent() < total / 2)
    } finally {
      await upstream.close()
    }
  })

  it('aborts a body that stalls after headers', { timeout: 2_000 }, async () => {
    const started = Date.now()
    const result = await fetchMediaWith(async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          const abort = () => {
            try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } catch { /* already closed */ }
          }
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'image/gif' } })
    }, { timeoutMs: 200 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 502)
    assert.ok(Date.now() - started < 1_500)
  })

  it('does not fetch an unsafe url', async () => {
    let called = false
    const result = await fetchMedia('http://files.kick.com/a.webp', {
      fetchImpl: async () => {
        called = true
        return image(new Uint8Array([1]))
      },
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 400)
    assert.equal(called, false)
  })

  it('passes through an upstream error status', async () => {
    const result = await fetchMediaWith(async () => new Response('missing', { status: 404 }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 404)
  })
})
