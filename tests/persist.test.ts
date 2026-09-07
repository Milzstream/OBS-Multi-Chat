import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createActivityStore } from '../server/activity.js'
import { readJsonFile, resolveDataDir, writeJsonAtomic } from '../server/persist.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-persist-'))
}

describe('packaged data directory', () => {
  it('stores packaged data beside the executable, not cwd', () => {
    const exe = path.join(os.tmpdir(), 'relay-install', 'relay-chat-dock.exe')
    const cwd = path.join(os.tmpdir(), 'other-cwd')
    assert.equal(resolveDataDir({ packaged: true, execPath: exe, cwd, env: {} }), path.join(path.dirname(exe), 'data'))
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
