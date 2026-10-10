import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, it } from 'node:test'
import { fetchTimed } from '../server/fetch-timed.js'

async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = createServer(handler)
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function timeoutCount() {
  return process.getActiveResourcesInfo().filter((item) => item === 'Timeout').length
}

describe('fetchTimed', () => {
  it('returns the body and clears the timer', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': '1' })
      res.end('{"a":1}')
    })
    const before = timeoutCount()
    try {
      const response = await fetchTimed(`${server.url}/`, {}, 5_000)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/json')
      assert.equal(response.headers.get('x-test'), '1')
      assert.deepEqual(await response.json(), { a: 1 })
      assert.equal(timeoutCount(), before)
    } finally {
      await server.close()
    }
  })

  it('forwards method, headers, and body', async () => {
    let seen: RequestInit | undefined
    const response = await fetchTimed('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{"a":1}',
    }, 1_000, async (_url, init) => {
      seen = init
      return new Response('ok', { status: 201, headers: { 'X-Test': 'yes' } })
    })
    assert.equal(response.status, 201)
    assert.equal(await response.text(), 'ok')
    assert.equal(seen?.method, 'POST')
    assert.equal(seen?.body, '{"a":1}')
    assert.equal(new Headers(seen?.headers).get('content-type'), 'application/json')
    assert.equal(seen?.signal?.aborted, false)
  })

  it('preserves the timeout error when headers never arrive', async () => {
    const server = await listen(() => {})
    const started = Date.now()
    try {
      await assert.rejects(fetchTimed(`${server.url}/`, {}, 200), /Request timed out after 200ms/)
      assert.ok(Date.now() - started < 1_500)
    } finally {
      await server.close()
    }
  })

  it('aborts when headers arrive but the body never completes', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('hi')
    })
    const started = Date.now()
    const before = timeoutCount()
    try {
      const response = await fetchTimed(`${server.url}/`, {}, 200)
      await assert.rejects(response.text(), /Request timed out after 200ms/)
      assert.ok(Date.now() - started < 1_500)
      assert.equal(timeoutCount(), before)
    } finally {
      await server.close()
    }
  })

  it('rejects a later body read if the timeout fired while the body was unread', async () => {
    const response = await fetchTimed('https://example.com/stall', {}, 50, async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([104, 105]))
          const abort = () => {
            try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } catch { /* already closed */ }
          }
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    await assert.rejects(response.text(), /Request timed out after 50ms/)
  })

  it('does not relabel other failures as timeouts', async () => {
    await assert.rejects(
      fetchTimed('https://example.com/x', {}, 1_000, async () => { throw new Error('boom') }),
      /boom/,
    )
  })
})
