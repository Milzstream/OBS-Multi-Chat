import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express from 'express'
import {
  ALERT_ASSET_JSON_LIMIT,
  ALERT_ASSET_MAX_BYTES,
  alertAssetMaxBytes,
  readAlertAsset,
  registerAlertAssetRoutes,
  resolveAlertAssetPath,
  pruneAlertAssets,
  saveAlertAsset,
  sniffAlertMime,
} from '../server/alert-assets.js'
import { classifyAccess } from '../server/local-api.js'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const ASSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function wavBytes() {
  const samples = 16
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

function tempData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-alerts-'))
}

async function listen(app: express.Express) {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

describe('alert asset paths and caps', () => {
  it('rejects path traversal and non-UUID ids', () => {
    const dir = tempData()
    try {
      assert.equal(resolveAlertAssetPath(dir, ASSET_ID), path.join(dir, 'alerts', ASSET_ID))
      assert.equal(resolveAlertAssetPath(dir, ASSET_ID.toUpperCase()), path.join(dir, 'alerts', ASSET_ID))
      assert.equal(resolveAlertAssetPath(dir, '../settings.json'), undefined)
      assert.equal(resolveAlertAssetPath(dir, '..\\..\\windows\\system.ini'), undefined)
      assert.equal(resolveAlertAssetPath(dir, `${ASSET_ID}/../settings.json`), undefined)
      assert.equal(resolveAlertAssetPath(dir, 'not-a-uuid'), undefined)
      assert.equal(resolveAlertAssetPath(dir, ''), undefined)
      assert.equal(resolveAlertAssetPath(dir, '/etc/passwd'), undefined)
      assert.equal(alertAssetMaxBytes('image/png'), ALERT_ASSET_MAX_BYTES.image)
      assert.equal(alertAssetMaxBytes('video/mp4'), ALERT_ASSET_MAX_BYTES.video)
      assert.equal(alertAssetMaxBytes('audio/mpeg'), ALERT_ASSET_MAX_BYTES.audio)
      assert.equal(alertAssetMaxBytes('text/html'), 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sniffs allowed types and rejects a text file claiming to be a png', () => {
    assert.equal(sniffAlertMime(PNG_1X1), 'image/png')
    assert.equal(sniffAlertMime(wavBytes()), 'audio/wav')
    assert.equal(sniffAlertMime(Buffer.from('hello')), undefined)
    const dir = tempData()
    try {
      const denied = saveAlertAsset(dir, { name: 'x.png', mime: 'image/png', data: Buffer.from('<script>').toString('base64') })
      assert.equal(denied.ok, false)
      const oversized = Buffer.concat([PNG_1X1, Buffer.alloc(ALERT_ASSET_MAX_BYTES.image)])
      oversized[0] = 0x89
      oversized[1] = 0x50
      oversized[2] = 0x4e
      oversized[3] = 0x47
      const big = saveAlertAsset(dir, { name: 'big.png', mime: 'image/png', data: oversized.toString('base64') })
      assert.equal(big.ok, false)
      if (!big.ok) assert.match(big.error, /too large/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes a UUID file and reads it back, and a missing id is absent', () => {
    const dir = tempData()
    try {
      const saved = saveAlertAsset(dir, { name: 'banner.png', mime: 'image/png', data: PNG_1X1.toString('base64') }, () => ASSET_ID)
      assert.equal(saved.ok, true)
      if (!saved.ok) return
      assert.equal(saved.asset.id, ASSET_ID)
      assert.equal(saved.asset.mime, 'image/png')
      assert.equal(saved.asset.name, 'banner.png')
      assert.equal(fs.existsSync(path.join(dir, 'alerts', ASSET_ID)), true)
      const read = readAlertAsset(dir, ASSET_ID)
      assert.equal(read?.mime, 'image/png')
      assert.equal(read?.name, 'banner.png')
      assert.deepEqual(read?.body, PNG_1X1)
      assert.equal(readAlertAsset(dir, 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'), undefined)
      assert.equal(readAlertAsset(dir, '../settings.json'), undefined)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prunes unreferenced UUID files and leaves kept ones plus non-UUID names', () => {
    const dir = tempData()
    try {
      const kept = saveAlertAsset(dir, { name: 'keep.png', mime: 'image/png', data: PNG_1X1.toString('base64') }, () => ASSET_ID)
      const dropId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      saveAlertAsset(dir, { name: 'drop.png', mime: 'image/png', data: PNG_1X1.toString('base64') }, () => dropId)
      const extra = path.join(dir, 'alerts', 'readme.txt')
      fs.writeFileSync(extra, 'leave me')
      assert.equal(kept.ok, true)
      const pruned = pruneAlertAssets(dir, [ASSET_ID])
      assert.deepEqual(pruned.removed, [dropId])
      assert.equal(fs.existsSync(path.join(dir, 'alerts', ASSET_ID)), true)
      assert.equal(fs.existsSync(path.join(dir, 'alerts', `${ASSET_ID}.meta`)), true)
      assert.equal(fs.existsSync(path.join(dir, 'alerts', dropId)), false)
      assert.equal(fs.existsSync(path.join(dir, 'alerts', `${dropId}.meta`)), false)
      assert.equal(fs.readFileSync(extra, 'utf8'), 'leave me')
      assert.deepEqual(pruneAlertAssets(dir, [ASSET_ID]).removed, [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('alert asset HTTP', () => {
  it('serves a stored file and 404s traversal or a missing id', async () => {
    const dir = tempData()
    const app = express()
    app.use(express.json({ limit: ALERT_ASSET_JSON_LIMIT }))
    registerAlertAssetRoutes(app, dir)
    const server = await listen(app)
    try {
      const missing = await fetch(`${server.url}/alerts/assets/${ASSET_ID}`)
      assert.equal(missing.status, 404)
      const traversal = await fetch(`${server.url}/alerts/assets/${encodeURIComponent('../settings.json')}`)
      assert.equal(traversal.status, 404)
      const posted = await fetch(`${server.url}/api/alerts/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dot.png', mime: 'image/png', data: PNG_1X1.toString('base64') }),
      })
      assert.equal(posted.status, 200)
      const asset = await posted.json() as { id: string; mime: string }
      assert.equal(asset.mime, 'image/png')
      const ok = await fetch(`${server.url}/alerts/assets/${asset.id}`)
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('content-type'), 'image/png')
      const body = Buffer.from(await ok.arrayBuffer())
      assert.deepEqual(body, PNG_1X1)
      const rejected = await fetch(`${server.url}/api/alerts/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x.txt', mime: 'text/plain', data: Buffer.from('hi').toString('base64') }),
      })
      assert.equal(rejected.status, 400)
    } finally {
      await server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps GET /alerts/assets on the streaming PC like /alerts', () => {
    assert.equal(classifyAccess('GET', `/alerts/assets/${ASSET_ID}`), 'operator')
    assert.equal(classifyAccess('POST', '/api/alerts/assets'), 'write')
    assert.equal(classifyAccess('GET', '/alerts'), 'operator')
  })
})
