import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createActivityStore } from '../server/activity.js'
import { compareVersions, getCurrentVersion, isDesktopPackaged, pickInstallerAsset, versionManifestPaths } from '../server/check-update.js'
import { commitJsonReplace, createDebouncedSave, readJsonFile, resolveDataDir, writeJsonAtomic } from '../server/persist.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-persist-'))
}

describe('release update helpers', () => {
  it('compares versions and picks the Windows setup asset', () => {
    assert.equal(compareVersions('0.5.0', '0.4.8'), 1)
    assert.equal(compareVersions('v0.5.0', '0.5.0'), 0)
    assert.equal(compareVersions('0.4.9', '0.5.0'), -1)
    assert.equal(pickInstallerAsset([
      { name: 'obs-multi-chat-v0.5.0-windows-x64.zip', browser_download_url: 'https://example/x.zip' },
      { name: 'obs-multi-chat-v0.5.0-windows-x64-setup.exe', browser_download_url: 'https://example/setup.exe' },
    ]), 'https://example/setup.exe')
    assert.equal(pickInstallerAsset([{ name: 'notes.md', browser_download_url: 'https://example/n' }]), undefined)
  })
})

describe('packaged version manifest', () => {
  it('reads package.json beside the exe and does not walk into parent folders', () => {
    const execPath = path.join(os.tmpdir(), 'relay-install', 'relay-chat-dock.exe')
    const cwd = path.join(os.tmpdir(), 'relay-install')
    assert.deepEqual(versionManifestPaths({ packaged: true, cwd, execPath }), [
      path.join(os.tmpdir(), 'relay-install', 'package.json'),
      path.join(os.tmpdir(), 'relay-install', 'package.json'),
    ])
  })

  it('treats pkg, electron, and RELAY_PACKAGED as a desktop build', () => {
    const previousPackaged = process.env.RELAY_PACKAGED
    const previousElectron = process.versions.electron
    const previousDefaultApp = process.defaultApp
    delete process.env.RELAY_PACKAGED
    delete process.versions.electron
    delete process.defaultApp
    assert.equal(isDesktopPackaged(), Boolean(process.pkg))
    process.env.RELAY_PACKAGED = '1'
    assert.equal(isDesktopPackaged(), true)
    delete process.env.RELAY_PACKAGED
    process.versions.electron = '33.0.0'
    process.defaultApp = true
    assert.equal(isDesktopPackaged(), Boolean(process.pkg))
    delete process.defaultApp
    assert.equal(isDesktopPackaged(), true)
    if (previousPackaged == null) delete process.env.RELAY_PACKAGED
    else process.env.RELAY_PACKAGED = previousPackaged
    if (previousElectron == null) delete process.versions.electron
    else process.versions.electron = previousElectron
    if (previousDefaultApp == null) delete process.defaultApp
    else process.defaultApp = previousDefaultApp
  })

  it('reads the electron app root package.json first', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    const previous = process.env.RELAY_APP_ROOT
    process.env.RELAY_APP_ROOT = dir
    try {
      assert.equal(getCurrentVersion(), '9.9.9')
    } finally {
      if (previous == null) delete process.env.RELAY_APP_ROOT
      else process.env.RELAY_APP_ROOT = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('packaged data directory', () => {
  it('stores packaged portable data beside the executable, not cwd', () => {
    const exe = path.join(os.tmpdir(), 'relay-install', 'relay-chat-dock.exe')
    const cwd = path.join(os.tmpdir(), 'other-cwd')
    assert.equal(resolveDataDir({ packaged: true, execPath: exe, cwd, env: {} }), path.join(path.dirname(exe), 'data'))
  })

  it('stores installer-managed data under LocalAppData', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ins-'))
    const exe = path.join(dir, 'relay-chat-dock.exe')
    fs.writeFileSync(path.join(dir, 'installed.origin'), 'installer\n')
    const local = path.join(os.tmpdir(), 'localapp-relay')
    try {
      assert.equal(resolveDataDir({ packaged: true, execPath: exe, cwd: path.join(os.tmpdir(), 'cwd'), env: { LOCALAPPDATA: local } }), path.join(local, 'Relay Chat Dock', 'data'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps development data under the project cwd', () => {
    const cwd = path.join(os.tmpdir(), 'relay-dev')
    assert.equal(resolveDataDir({ packaged: false, execPath: '/usr/bin/node', cwd, env: {} }), path.join(cwd, 'data'))
  })

  it('honors RELAY_DATA_DIR over packaged and cwd defaults', () => {
    const configured = path.join(os.tmpdir(), 'relay-custom-data')
    assert.equal(resolveDataDir({
      packaged: true,
      execPath: path.join(os.tmpdir(), 'relay-install', 'relay-chat-dock.exe'),
      cwd: path.join(os.tmpdir(), 'other-cwd'),
      env: { RELAY_DATA_DIR: configured },
    }), path.resolve(configured))
  })
})

describe('debounced save', () => {
  it('writes once for a burst and again on flush', () => {
    let writes = 0
    let pending: (() => void) | undefined
    const save = createDebouncedSave(() => { writes += 1 }, 1000, {
      set: (fn) => { pending = fn as () => void; return 1 as unknown as ReturnType<typeof setTimeout> },
      clear: () => { pending = undefined },
    })
    save.schedule()
    save.schedule()
    assert.equal(writes, 0)
    pending?.()
    assert.equal(writes, 1)
    save.schedule()
    save.flush()
    assert.equal(writes, 2)
    save.flush()
    assert.equal(writes, 2)
  })
})

describe('atomic JSON persistence', () => {
  it('replaces the destination and keeps a backup of the previous file', () => {
    const dir = tempDir()
    const file = path.join(dir, 'tokens.json')
    try {
      writeJsonAtomic(file, { accessToken: 'old' })
      writeJsonAtomic(file, { accessToken: 'new' })
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { accessToken: 'new' })
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { accessToken: 'old' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not delete the live file when the backup rename fails', () => {
    const removed: string[] = []
    let copied = false
    const file = 'tokens.json'
    const ok = commitJsonReplace(file, 'tokens.json.1.tmp', 'tokens.json.bak', {
      existsSync: () => true,
      readFileSync: () => '{"accessToken":"old"}',
      rmSync: (target) => { removed.push(target) },
      renameSync: (_from, to) => { if (String(to).endsWith('.bak')) throw new Error('EPERM') },
      copyFileSync: () => { copied = true },
    })
    assert.equal(ok, true)
    assert.equal(copied, true)
    assert.equal(removed.includes(file), false)
  })

  it('recovers from a truncated destination using the backup', () => {
    const dir = tempDir()
    const file = path.join(dir, 'settings.json')
    try {
      writeJsonAtomic(file, { keep: 'first' })
      writeJsonAtomic(file, { keep: 'second' })
      fs.writeFileSync(file, '{ truncated')
      assert.deepEqual(readJsonFile(file, { keep: 'fallback' }), { keep: 'first' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reloads activity history from the backup after a corrupt write', () => {
    const dir = tempDir()
    const file = path.join(dir, 'activity.json')
    try {
      const store = createActivityStore(file)
      assert.equal(store.add({ id: 'follow-1', platform: 'Twitch', kind: 'follow', user: 'Ada', time: '2026-09-02T12:00:00.000Z' }), true)
      const bak = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      fs.writeFileSync(`${file}.bak`, JSON.stringify(bak))
      fs.writeFileSync(file, '[')
      const recovered = createActivityStore(file)
      assert.equal(recovered.list().some((event) => event.id === 'follow-1'), true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
