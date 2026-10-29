import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express from 'express'
import {
  listInstalledAlertFonts,
  parseInstalledFontOutput,
  registerAlertFontRoutes,
  resetAlertFontCache,
  windowsInstalledFontsPlan,
} from '../server/alert-fonts.js'
import { ALERT_FONTS } from '../server/logic.js'
import { classifyAccess } from '../server/local-api.js'

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

describe('installed overlay fonts', () => {
  it('lists GDI+ families through PowerShell JSON', () => {
    const plan = windowsInstalledFontsPlan()
    assert.equal(plan.command, 'powershell.exe')
    assert.ok(plan.args.includes('-NoProfile'))
    assert.match(plan.args.at(-1) || '', /InstalledFontCollection/)
    assert.match(plan.args.at(-1) || '', /ConvertTo-Json/)
    assert.deepEqual(parseInstalledFontOutput('["Bebas Neue","Public Pixel"]'), ['Bebas Neue', 'Public Pixel'])
    assert.deepEqual(parseInstalledFontOutput('"Arial"'), ['Arial'])
    assert.deepEqual(parseInstalledFontOutput('Impact\r\nComic Sans MS'), ['Impact', 'Comic Sans MS'])
    assert.deepEqual(parseInstalledFontOutput(''), [])
  })

  it('keeps GET /api/alerts/fonts on this computer', () => {
    assert.equal(classifyAccess('GET', '/api/alerts/fonts'), 'operator')
    assert.equal(classifyAccess('POST', '/api/alerts/fonts'), 'write')
  })

  it('returns Outfit first, then safe installed names', async () => {
    const app = express()
    registerAlertFontRoutes(app, { list: async () => ['Bebas Neue', 'url(https://evil.example)', 'Arial', 'Outfit'] })
    const server = await listen(app)
    try {
      const response = await fetch(`${server.url}/api/alerts/fonts`)
      assert.equal(response.status, 200)
      const body = await response.json() as { fonts: string[] }
      assert.equal(body.fonts[0], 'Outfit')
      assert.ok(body.fonts.includes('Bebas Neue'))
      assert.ok(body.fonts.includes('Arial'))
      assert.equal(body.fonts.some((name) => /url/i.test(name)), false)
    } finally {
      await server.close()
    }
  })

  it('falls back to common Windows faces when listing fails', async () => {
    const app = express()
    registerAlertFontRoutes(app, { list: async () => { throw new Error('powershell missing') } })
    const server = await listen(app)
    try {
      const response = await fetch(`${server.url}/api/alerts/fonts`)
      assert.equal(response.status, 200)
      const body = await response.json() as { fonts: string[] }
      assert.deepEqual(body.fonts, [...ALERT_FONTS])
    } finally {
      await server.close()
    }
  })

  it('parses PowerShell stdout through the exec seam', async () => {
    resetAlertFontCache()
    const fonts = await listInstalledAlertFonts((_file, args, _options, callback) => {
      assert.match(args.at(-1) || '', /InstalledFontCollection/)
      callback(null, JSON.stringify(['Airborne Pilot', 'Public Pixel']), '')
    })
    assert.deepEqual(fonts, ['Airborne Pilot', 'Public Pixel'])
  })

  it('lists Arial from this Windows install', async () => {
    if (process.platform !== 'win32') return
    resetAlertFontCache()
    const names = await listInstalledAlertFonts()
    assert.ok(names.some((name) => name.toLowerCase() === 'arial'), `expected Arial in ${names.slice(0, 8).join(', ')}`)
  })
})
