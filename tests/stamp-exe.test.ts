import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const { parseAppVersion, readWindowsVersion, stampAndVerifyWindowsExe } = require('../scripts/stamp-windows-exe.cjs') as {
  parseAppVersion: (version: string) => { major: number; minor: number; patch: number; revision: number; fileVersion: string; productVersion: string }
  readWindowsVersion: (exePath: string) => Promise<{ fileVersionRaw: string; productVersion: string; internalName: string; originalFilename: string } | null>
  stampAndVerifyWindowsExe: (exePath: string, options: Record<string, unknown>) => Promise<{ fileVersionRaw: string }>
}

describe('Windows exe version stamp', () => {
  it('maps the package version to a four-part Windows file version', () => {
    assert.deepEqual(parseAppVersion('0.9.4'), {
      major: 0,
      minor: 9,
      patch: 4,
      revision: 0,
      fileVersion: '0.9.4.0',
      productVersion: '0.9.4',
    })
    assert.equal(parseAppVersion('v1.2.3').fileVersion, '1.2.3.0')
    assert.equal(parseAppVersion('2.0.0.7').fileVersion, '2.0.0.7')
  })

  it('stamps a Windows exe so FileVersion is the app version, not Electron', async function () {
    if (process.platform !== 'win32') return
    const source = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
    if (!fs.existsSync(source)) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stamp-'))
    const exePath = path.join(dir, 'relay-chat-dock.exe')
    try {
      fs.copyFileSync(source, exePath)
      const before = await readWindowsVersion(exePath)
      assert.notEqual(before?.fileVersionRaw, '0.9.4.0')
      await stampAndVerifyWindowsExe(exePath, {
        version: '0.9.4',
        originalFilename: 'relay-chat-dock.exe',
        productName: 'Relay Chat Dock',
        fileDescription: 'Relay Chat Dock',
        company: 'Milzstream',
      })
      const after = await readWindowsVersion(exePath)
      assert.equal(after?.fileVersionRaw, '0.9.4.0')
      assert.equal(after?.productVersion, '0.9.4')
      assert.equal(after?.internalName, 'relay-chat-dock.exe')
      assert.equal(after?.originalFilename, 'relay-chat-dock.exe')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
