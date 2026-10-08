import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createLogBuffer } from '../server/log-buffer.js'
import { createLogFile, formatLogFileLine, redactLogSecrets, resolveLogFilePath } from '../server/log-file.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-log-'))
}

describe('companion crash log', () => {
  it('redacts watch tokens, JWTs, and oauth secrets', () => {
    const text = [
      'Watch          http://192.168.1.20:4173/watch?token=view-secret',
      'Cookie relay_watch=view-secret; Path=/',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.abc',
      'client_secret=super-secret',
      'Twitch access token refreshed',
    ].join('\n')
    const redacted = redactLogSecrets(text)
    assert.equal(redacted.includes('view-secret'), false)
    assert.equal(redacted.includes('super-secret'), false)
    assert.equal(redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false)
    assert.match(redacted, /token=<redacted>/)
    assert.match(redacted, /relay_watch=<redacted>/)
    assert.match(redacted, /Bearer <redacted>/)
    assert.match(redacted, /client_secret=<redacted>/)
    assert.match(redacted, /Twitch access token refreshed/)
  })

  it('writes beside production.env and rotates into a backup', () => {
    const dir = tempDir()
    try {
      const filePath = resolveLogFilePath(dir)
      assert.equal(filePath, path.join(dir, 'logs', 'relay.log'))
      const log = createLogFile({ filePath, maxBytes: 80, flushMs: 60_000 })
      log.writeLine({ time: '2026-10-08T00:00:00.000Z', level: 'log', text: 'first line with token=secret-value' })
      log.flush()
      const first = fs.readFileSync(filePath, 'utf8')
      assert.match(first, /token=<redacted>/)
      assert.equal(first.includes('secret-value'), false)
      log.writeLine({ time: '2026-10-08T00:00:01.000Z', level: 'warn', text: 'second line that forces a rotate' })
      log.flush()
      assert.equal(fs.existsSync(`${filePath}.bak`), true)
      const bak = fs.readFileSync(`${filePath}.bak`, 'utf8')
      const next = fs.readFileSync(filePath, 'utf8')
      assert.match(bak, /first line/)
      assert.match(next, /second line/)
      assert.equal(next.includes('first line'), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flushes buffered lines so a crash still has the last writes', () => {
    const dir = tempDir()
    try {
      const filePath = path.join(dir, 'logs', 'relay.log')
      let scheduled: (() => void) | undefined
      const log = createLogFile({
        filePath,
        flushMs: 10_000,
        timers: {
          set: ((fn: () => void) => {
            scheduled = fn
            return 1 as unknown as ReturnType<typeof setTimeout>
          }) as typeof setTimeout,
          clear: (() => { scheduled = undefined }) as typeof clearTimeout,
        },
      })
      const buffer = createLogBuffer(8)
      buffer.subscribe((line) => log.writeLine(line))
      buffer.push('error', ['Kick chat: boom'])
      assert.equal(fs.existsSync(filePath), false)
      log.flush()
      assert.equal(scheduled, undefined)
      const body = fs.readFileSync(filePath, 'utf8')
      assert.match(body, /ERROR Kick chat: boom/)
      assert.equal(formatLogFileLine({ time: 't', level: 'log', text: 'ok' }), 't LOG ok\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
