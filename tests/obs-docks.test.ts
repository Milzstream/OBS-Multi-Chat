import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  applyRelayDocksToIni,
  canonicalDockUrl,
  dockUrlPresent,
  extraBrowserDocksFile,
  mergeRelayDocks,
  missingRelayDockUrls,
  obsProcessRunning,
  operatorFilesDir,
  parseExtraBrowserDocks,
  readIniValue,
  relayDockUrls,
  resolveObsConfigDir,
  sameDockUrl,
  writeIniValue,
} from '../server/obs-docks.js'

describe('dock URL identity', () => {
  it('treats localhost and 127.0.0.1 and trailing slashes as the same dock', () => {
    assert.equal(canonicalDockUrl('http://localhost:4173/'), '127.0.0.1:4173')
    assert.equal(canonicalDockUrl('http://127.0.0.1:4173'), '127.0.0.1:4173')
    assert.equal(canonicalDockUrl('http://127.0.0.1:4173/activity/'), '127.0.0.1:4173/activity')
    assert.equal(sameDockUrl('http://localhost:4173/', 'http://127.0.0.1:4173'), true)
    assert.equal(sameDockUrl('http://localhost:4173/activity', 'http://127.0.0.1:4173/activity/'), true)
    assert.equal(sameDockUrl('http://127.0.0.1:4173/', 'http://127.0.0.1:4173/activity'), false)
  })
})

describe('merge relay docks', () => {
  it('skips URLs that already exist even if the title differs, and appends only missing ones', () => {
    const existing = [
      { title: 'Chat', url: 'http://localhost:4173/', uuid: 'aaa' },
      { title: 'Other', url: 'https://example.com/dock', uuid: 'bbb' },
    ]
    const merged = mergeRelayDocks(existing, relayDockUrls(4173), () => 'new-id')
    assert.equal(merged.added.length, 1)
    assert.equal(merged.added[0].title, 'Relay Activity')
    assert.equal(merged.added[0].url, 'http://127.0.0.1:4173/activity')
    assert.equal(merged.docks.length, 3)
    assert.equal(merged.docks[1].url, 'https://example.com/dock')
    assert.equal(dockUrlPresent(merged.docks, 'http://127.0.0.1:4173/'), true)
    assert.deepEqual(missingRelayDockUrls(existing, 4173).map((item) => item.title), ['Relay Activity'])
    assert.deepEqual(missingRelayDockUrls(merged.docks, 4173), [])
  })
})

describe('OBS ExtraBrowserDocks ini', () => {
  it('parses, writes, and preserves other keys including DockState', () => {
    const ini = [
      '[BasicWindow]',
      'DockState=AAAA',
      'ExtraBrowserDocks=[{"title": "Shared Chat", "url": "https://example.com/x", "uuid": "old"}]',
      'AlwaysOnTop=false',
      '',
    ].join('\n')
    assert.equal(readIniValue(ini, 'BasicWindow', 'DockState'), 'AAAA')
    const docks = parseExtraBrowserDocks(readIniValue(ini, 'BasicWindow', 'ExtraBrowserDocks') || '')
    assert.equal(docks?.[0].title, 'Shared Chat')
    const applied = applyRelayDocksToIni(ini, 4173, () => 'uuid-1')
    assert.equal(applied.ok, true)
    assert.equal(applied.reason, 'added')
    assert.equal(applied.added.length, 2)
    assert.match(applied.text, /DockState=AAAA/)
    assert.match(applied.text, /AlwaysOnTop=false/)
    assert.match(applied.text, /https:\/\/example.com\/x/)
    assert.match(applied.text, /127\.0\.0\.1:4173\/activity/)
    const again = applyRelayDocksToIni(applied.text, 4173, () => 'uuid-2')
    assert.equal(again.reason, 'exists')
    assert.equal(again.text, applied.text)
  })

  it('creates the BasicWindow key when the section is missing', () => {
    const applied = applyRelayDocksToIni('[General]\nLanguage=en-US\n', 4173, () => 'id')
    assert.equal(applied.reason, 'added')
    assert.match(applied.text, /\[BasicWindow\]/)
    assert.match(applied.text, /ExtraBrowserDocks=/)
  })

  it('returns unknown-format when ExtraBrowserDocks is not JSON', () => {
    const ini = '[BasicWindow]\nExtraBrowserDocks=not-json\n'
    const applied = applyRelayDocksToIni(ini, 4173)
    assert.equal(applied.ok, false)
    assert.equal(applied.reason, 'unknown-format')
  })

  it('writes missing docks into a real user.ini and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-obs-write-'))
    try {
      const file = path.join(dir, 'user.ini')
      fs.writeFileSync(file, '[BasicWindow]\nDockState=keep-me\nExtraBrowserDocks=[{"title":"Other","url":"https://example.com","uuid":"o"}]\n')
      const first = applyRelayDocksToIni(fs.readFileSync(file, 'utf8'), 4173, () => 'n1')
      fs.writeFileSync(file, first.text)
      assert.equal(first.reason, 'added')
      assert.match(fs.readFileSync(file, 'utf8'), /DockState=keep-me/)
      const second = applyRelayDocksToIni(fs.readFileSync(file, 'utf8'), 4173, () => 'n2')
      assert.equal(second.reason, 'exists')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers user.ini over global.ini', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-obs-'))
    try {
      fs.writeFileSync(path.join(dir, 'global.ini'), '[BasicWindow]\n')
      assert.equal(extraBrowserDocksFile(dir), path.join(dir, 'global.ini'))
      fs.writeFileSync(path.join(dir, 'user.ini'), '[BasicWindow]\n')
      assert.equal(extraBrowserDocksFile(dir), path.join(dir, 'user.ini'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OBS config discovery', () => {
  it('picks the first candidate that has user.ini and does not assume Program Files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-obs-cfg-'))
    const roaming = path.join(dir, 'Roaming', 'obs-studio')
    fs.mkdirSync(roaming, { recursive: true })
    fs.writeFileSync(path.join(roaming, 'user.ini'), '[BasicWindow]\n')
    const found = resolveObsConfigDir({ APPDATA: path.join(dir, 'Roaming'), ProgramFiles: path.join(dir, 'missing-pf') }, [])
    assert.equal(found, roaming)
  })

  it('accepts an explicit extra dir when AppData has no OBS settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-obs-extra-'))
    try {
      fs.writeFileSync(path.join(dir, 'user.ini'), '[BasicWindow]\n')
      assert.equal(resolveObsConfigDir({ APPDATA: path.join(dir, 'nope') }, [dir]), dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OBS process detection', () => {
  it('detects obs64.exe from tasklist output', () => {
    assert.equal(obsProcessRunning('obs64.exe                    123 Console                    1     200,000 K'), true)
    assert.equal(obsProcessRunning('INFO: No tasks are running which match the specified criteria.'), false)
  })
})

describe('installer vs portable file locations', () => {
  it('keeps portable data beside the exe and installer data under LocalAppData', () => {
    const exe = path.join(os.tmpdir(), 'pf', 'Relay Chat Dock', 'relay-chat-dock.exe')
    const cwd = path.join(os.tmpdir(), 'cwd')
    const local = path.join(os.tmpdir(), 'localapp')
    assert.equal(operatorFilesDir({ packaged: true, execPath: exe, cwd, env: {} }), path.dirname(exe))
    const pfExe = path.join('C:\\Program Files\\Relay Chat Dock', 'relay-chat-dock.exe')
    assert.equal(operatorFilesDir({ packaged: true, execPath: pfExe, cwd, env: { LOCALAPPDATA: local } }), path.join(local, 'Relay Chat Dock'))
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-marker-'))
    const markerExe = path.join(markerDir, 'relay-chat-dock.exe')
    fs.writeFileSync(path.join(markerDir, 'installed.origin'), 'installer\n')
    try {
      assert.equal(operatorFilesDir({ packaged: true, execPath: markerExe, cwd, env: { LOCALAPPDATA: local } }), path.join(local, 'Relay Chat Dock'))
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true })
    }
  })
})

describe('ini writer', () => {
  it('updates an existing key in place', () => {
    const next = writeIniValue('[A]\nK=old\nZ=1\n', 'A', 'K', 'new')
    assert.equal(readIniValue(next, 'A', 'K'), 'new')
    assert.equal(readIniValue(next, 'A', 'Z'), '1')
  })
})
