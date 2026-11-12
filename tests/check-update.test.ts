import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkForUpdates, confirmWithSpawn, digestMatches, escapePowerShellHereString, installerDownloadAllowed, installerSetupPath, releaseNotesExcerpt, releaseNotesPath, updateAvailableMessage, updatePromptMessage, windowsReleaseNotesCommand, type GitHubRelease } from '../server/check-update.js'

function release(tag: string): GitHubRelease {
  return {
    tag_name: tag,
    html_url: `https://github.com/Milzstream/OBS-Multi-Chat/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `obs-multi-chat-${tag}-windows-x64-setup.exe`, browser_download_url: 'https://example/setup.exe' }],
  }
}

const releaseBody = [
  'Windows x64 build of Relay Chat Dock.',
  '',
  '**Installer (recommended):** run `obs-multi-chat-v*-windows-x64-setup.exe`.',
  '',
  "## What's Changed",
  '* show release notes by @Milzstream in https://github.com/Milzstream/OBS-Multi-Chat/pull/191',
  '',
  '**Full Changelog**: https://github.com/Milzstream/OBS-Multi-Chat/compare/v1.1.6...v1.1.7',
].join('\n')

function downloadable(tag: string, body?: string | null): GitHubRelease {
  const bytes = Buffer.from('setup-bytes')
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
  return {
    ...release(tag),
    body,
    assets: [{
      name: `obs-multi-chat-${tag}-windows-x64-setup.exe`,
      browser_download_url: `https://github.com/Milzstream/OBS-Multi-Chat/releases/download/${tag}/setup.exe`,
      digest,
    }],
  }
}

describe('update check flow', () => {
  it('does nothing when the latest tag is not newer', async () => {
    const started: string[] = []
    await checkForUpdates({
      currentVersion: '0.6.2',
      latestRelease: release('v0.6.2'),
      installerCopy: true,
      confirm: () => true,
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.deepEqual(started, [])
  })

  it('does nothing for a draft release', async () => {
    const started: string[] = []
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: { ...release('v0.6.2'), draft: true },
      installerCopy: true,
      confirm: () => true,
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.deepEqual(started, [])
  })

  it('logs only for a portable copy and does not start Setup', async () => {
    const started: string[] = []
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: release('v0.6.2'),
      installerCopy: false,
      confirm: () => true,
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.deepEqual(started, [])
  })

  it('does not download when the user declines', async () => {
    const started: string[] = []
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: release('v0.6.2'),
      installerCopy: true,
      confirm: () => false,
      download: async () => { started.push('download') },
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.deepEqual(started, [])
  })

  it('downloads Setup, starts it, then exits so the running exe is not a parent of Setup', async () => {
    const body = Buffer.from('setup-bytes')
    const digest = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`
    const started: string[] = []
    const latest = release('v0.6.2')
    latest.assets = [{
      name: 'obs-multi-chat-v0.6.2-windows-x64-setup.exe',
      browser_download_url: 'https://github.com/Milzstream/OBS-Multi-Chat/releases/download/v0.6.2/obs-multi-chat-v0.6.2-windows-x64-setup.exe',
      digest,
    }]
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: latest,
      installerCopy: true,
      confirm: () => true,
      download: async (_url, dest) => { fs.writeFileSync(dest, body); started.push('download') },
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.equal(started[0], 'download')
    assert.equal(started[1], installerSetupPath('v0.6.2'))
    assert.equal(started[2], 'exit')
  })

  it('does not download an unpinned URL or a release with no digest', async () => {
    const started: string[] = []
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: release('v0.6.2'),
      installerCopy: true,
      confirm: () => true,
      download: async () => { started.push('download') },
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    assert.deepEqual(started, [])
    assert.equal(installerDownloadAllowed('https://example/setup.exe'), false)
    assert.equal(installerDownloadAllowed('https://github.com/Milzstream/OBS-Multi-Chat/releases/download/v0.6.2/setup.exe'), true)
    assert.equal(digestMatches(Buffer.from('nope'), 'sha256:' + 'ab'.repeat(32)), false)
    assert.equal(escapePowerShellHereString("v0.1'@; calc"), "v0.1' @; calc")
    assert.equal(path.dirname(installerSetupPath('v/../../Users/Public/evil')), path.resolve(os.tmpdir()))
  })

  it('resolves the Yes/No prompt without blocking the event loop', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 5)
    const pending = confirmWithSpawn(() => ({
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'close') setTimeout(() => listener(0), 30)
      },
    }), 'Update?', 'Relay')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(ticks >= 1)
    assert.equal(await pending, true)
    clearInterval(timer)
    const declined = await confirmWithSpawn(() => ({
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'error') listener(new Error('missing'))
      },
    }), 'Update?', 'Relay')
    assert.equal(declined, false)
  })

  it('waits for an async confirm before downloading', async () => {
    const started: string[] = []
    let releaseConfirm: (yes: boolean) => void = () => undefined
    const pending = checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: release('v0.6.2'),
      installerCopy: true,
      confirm: () => new Promise((resolve) => { releaseConfirm = resolve }),
      download: async () => { started.push('download') },
      startInstaller: (dest) => started.push(dest),
      exit: () => started.push('exit'),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(started, [])
    releaseConfirm(false)
    await pending
    assert.deepEqual(started, [])
  })

  it('puts the notes excerpt in the confirm prompt and leaves the installer blurb out', async () => {
    let message = ''
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: downloadable('v0.6.2', releaseBody),
      installerCopy: true,
      confirm: (prompt) => { message = prompt; return false },
    })
    assert.match(message, /What's Changed/)
    assert.match(message, /Full notes: https:\/\/github.com\/Milzstream\/OBS-Multi-Chat\/releases\/tag\/v0\.6\.2/)
    assert.match(message, /production\.env/)
    assert.doesNotMatch(message, /Installer \(recommended\)/)
    assert.doesNotMatch(message, /\*\*/)
  })

  it('keeps the short prompt when the release has no notes', async () => {
    let message = ''
    await checkForUpdates({
      currentVersion: '0.6.1',
      latestRelease: downloadable('v0.6.2', null),
      installerCopy: true,
      confirm: (prompt) => { message = prompt; return false },
    })
    assert.equal(message, updateAvailableMessage('v0.6.2'))
    assert.doesNotMatch(message, /Full notes/)
  })

  it('logs the same excerpt for a portable copy and does not confirm or start Setup', async () => {
    const logs: string[] = []
    const started: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    try {
      await checkForUpdates({
        currentVersion: '0.6.1',
        latestRelease: { ...release('v0.6.2'), body: releaseBody },
        installerCopy: false,
        confirm: () => { started.push('confirm'); return true },
        startInstaller: () => started.push('start'),
        exit: () => started.push('exit'),
      })
    } finally {
      console.log = original
    }
    assert.deepEqual(started, [])
    const logged = logs.join('\n')
    assert.match(logged, /What's Changed/)
    assert.doesNotMatch(logged, /Installer \(recommended\)/)
  })
})

describe('release notes excerpt', () => {
  it('drops the installer blurb, strips markdown, and caps a long excerpt', () => {
    assert.equal(releaseNotesExcerpt(null), '')
    assert.equal(releaseNotesExcerpt(''), '')
    assert.equal(releaseNotesExcerpt('just a blurb'), '')
    assert.equal(releaseNotesExcerpt("## What's Changed"), '')
    const excerpt = releaseNotesExcerpt(releaseBody)
    assert.match(excerpt, /^What's Changed\n/)
    assert.match(excerpt, /Full Changelog: https:\/\/github.com\/Milzstream\/OBS-Multi-Chat\/compare\/v1\.1\.6\.\.\.v1\.1\.7/)
    assert.doesNotMatch(excerpt, /Installer \(recommended\)/)
    assert.doesNotMatch(excerpt, /\*\*/)
    assert.doesNotMatch(excerpt, /`/)
    const capped = releaseNotesExcerpt(`${releaseBody}\n${'x'.repeat(5000)}`, 80)
    assert.ok(capped.endsWith('\n…'))
    assert.ok(capped.length <= 82)
    const prompt = updatePromptMessage('v0.6.2', 'https://github.com/Milzstream/OBS-Multi-Chat/releases/tag/v0.6.2', capped)
    assert.match(prompt, /Full notes: https:\/\/github.com\/Milzstream\/OBS-Multi-Chat\/releases\/tag\/v0\.6\.2/)
  })

  it('keeps the notes text out of the PowerShell command', () => {
    const notes = 'SECRET-NOTES-BODY'
    const notesPath = releaseNotesPath('v/../../Users/Public/evil', os.tmpdir(), '../nope')
    assert.equal(path.dirname(notesPath), path.resolve(os.tmpdir()))
    const command = windowsReleaseNotesCommand(updateAvailableMessage('v1.1.7'), 'Relay Chat Dock', notesPath)
    assert.equal(command.includes(notes), false)
    assert.match(command, /ReadAllText/)
    assert.match(command, /ReadOnly = \$true/)
    assert.match(command, /ScrollBars = 'Vertical'/)
    assert.match(command, /exit 0/)
    assert.match(command, /exit 1/)
    assert.ok(command.includes(notesPath))
    const hostile = windowsReleaseNotesCommand("ok'@; calc", "title'@; calc", "C:\\Temp\\x'@notes.txt")
    assert.equal(hostile.includes("ok'@"), false)
    assert.equal(hostile.includes("title'@"), false)
    assert.equal(hostile.includes("x'@notes"), false)
    assert.match(hostile, /ok' @; calc/)
  })
})
