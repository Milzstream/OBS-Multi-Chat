import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { consoleHyperlink, envKeyFromLine, envKeys, fileUrl, hasDuplicateFilledValues, jwtPreview, looksLikeJwt, mergeEnvTemplate, resolveEnvFilePath, setEnvKey, syncEnvFile } from '../server/env-file.js'

describe('jwt preview', () => {
  it('never returns the full token', () => {
    assert.deepEqual(jwtPreview(''), { configured: false, last4: '' })
    assert.deepEqual(jwtPreview('secret-token-9876'), { configured: true, last4: '9876' })
    assert.equal(setEnvKey('STREAMELEMENTS_JWT_TWITCH=old\n', 'STREAMELEMENTS_JWT_TWITCH', '', true), 'STREAMELEMENTS_JWT_TWITCH=\n')
  })
})

describe('installer JWT checks', () => {
  it('accepts three-part JWTs and flags duplicate pasted values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjaGFubmVsIjoieCJ9.signature'
    assert.equal(looksLikeJwt(jwt), true)
    assert.equal(looksLikeJwt('not-a-jwt'), false)
    assert.equal(looksLikeJwt(''), false)
    assert.equal(hasDuplicateFilledValues(['aaa.bbb.ccc', 'aaa.bbb.ccc', '']), true)
    assert.equal(hasDuplicateFilledValues(['aaa.bbb.ccc', 'ddd.eee.fff', '']), false)
    assert.equal(hasDuplicateFilledValues(['', '', '']), false)
  })
})

describe('console file links', () => {
  it('builds a file URL and only wraps OSC-8 when the terminal supports it', () => {
    assert.equal(fileUrl('D:\\Code Projects\\OBS-Multi-Chat\\deploy\\production.env'), 'file:///D:/Code%20Projects/OBS-Multi-Chat/deploy/production.env')
    const label = 'D:\\env\\production.env'
    const url = fileUrl(label)
    assert.equal(consoleHyperlink(url, label, {}), label)
    assert.match(consoleHyperlink(url, label, { WT_SESSION: '1' }), /^\u001b]8;;file:\/\/\//)
  })
})

describe('set env key', () => {
  it('fills an existing uncommented key and ignores empty values', () => {
    const start = 'TWITCH_CLIENT_ID=\n# RELAY_BIND=127.0.0.1\nPORT=4173\n'
    assert.equal(setEnvKey(start, 'TWITCH_CLIENT_ID', ''), start)
    const next = setEnvKey(start, 'TWITCH_CLIENT_ID', 'abc')
    assert.match(next, /^TWITCH_CLIENT_ID=abc$/m)
    assert.match(next, /# RELAY_BIND=127\.0\.0\.1/)
    assert.match(setEnvKey(start, 'STREAMELEMENTS_JWT_TWITCH', 'jwt-value'), /STREAMELEMENTS_JWT_TWITCH=jwt-value/)
  })
})

describe('env key lines', () => {
  it('reads uncommented and commented KEY= lines, and ignores prose', () => {
    assert.deepEqual(envKeyFromLine('RELAY_CHAT_MAX=5000'), { key: 'RELAY_CHAT_MAX', commented: false })
    assert.deepEqual(envKeyFromLine('# RELAY_ACTIVITY_MAX=5000'), { key: 'RELAY_ACTIVITY_MAX', commented: true })
    assert.equal(envKeyFromLine('# Set RELAY_BIND=0.0.0.0 to allow other devices on your LAN.'), undefined)
    assert.equal(envKeyFromLine('# How many chat lines to keep'), undefined)
  })
})

describe('merge env template', () => {
  it('keeps existing values and appends missing keys, including commented optionals', () => {
    const existing = [
      'TWITCH_CLIENT_ID=keep-me',
      'PORT=4173',
      '# RELAY_CHAT_MAX=100',
      '',
    ].join('\n')
    const template = [
      '# Server-side OAuth configuration. Keep client secrets private.',
      'TWITCH_CLIENT_ID=',
      'PORT=4173',
      '# How many chat lines to keep in memory and in data/chat.json.',
      '# RELAY_CHAT_MAX=5000',
      '# How many activity alerts to keep in memory and in data/activity.json.',
      '# RELAY_ACTIVITY_MAX=5000',
      '# Optional Kick API base. Default is https://api.kick.com/public/v1',
      '# KICK_API_BASE=',
      '',
    ].join('\n')
    const merged = mergeEnvTemplate(existing, template)
    assert.deepEqual(merged.added, ['RELAY_ACTIVITY_MAX', 'KICK_API_BASE'])
    assert.match(merged.text, /TWITCH_CLIENT_ID=keep-me/)
    assert.match(merged.text, /# RELAY_CHAT_MAX=100/)
    assert.doesNotMatch(merged.text, /# RELAY_CHAT_MAX=5000/)
    assert.match(merged.text, /# RELAY_ACTIVITY_MAX=5000/)
    assert.match(merged.text, /# KICK_API_BASE=/)
    assert.ok(envKeys(merged.text).has('RELAY_ACTIVITY_MAX'))
  })

  it('is a no-op when every template key is already present', () => {
    const existing = 'PORT=4173\n# RELAY_ACTIVITY_MAX=9000\n'
    const merged = mergeEnvTemplate(existing, 'PORT=4173\n# RELAY_ACTIVITY_MAX=5000\n')
    assert.deepEqual(merged.added, [])
    assert.equal(merged.text, existing)
  })
})

describe('sync env file', () => {
  it('creates a missing env file from the template and later only appends new keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-env-'))
    const envPath = path.join(dir, 'production.env')
    const templatePath = path.join(dir, '.env.example')
    try {
      fs.writeFileSync(templatePath, 'TWITCH_CLIENT_ID=\n# RELAY_CHAT_MAX=5000\n')
      const created = syncEnvFile(envPath, templatePath)
      assert.equal(created.written, true)
      assert.deepEqual(created.added.sort(), ['RELAY_CHAT_MAX', 'TWITCH_CLIENT_ID'])
      fs.writeFileSync(envPath, 'TWITCH_CLIENT_ID=secret\n')
      fs.writeFileSync(templatePath, 'TWITCH_CLIENT_ID=\n# RELAY_CHAT_MAX=5000\n# RELAY_ACTIVITY_MAX=5000\n')
      const updated = syncEnvFile(envPath, templatePath)
      assert.deepEqual(updated.added, ['RELAY_CHAT_MAX', 'RELAY_ACTIVITY_MAX'])
      const text = fs.readFileSync(envPath, 'utf8')
      assert.match(text, /TWITCH_CLIENT_ID=secret/)
      assert.match(text, /# RELAY_ACTIVITY_MAX=5000/)
      assert.equal(resolveEnvFilePath(dir), envPath)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
