import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkForUpdates, digestMatches, escapePowerShellHereString, installerDownloadAllowed, installerSetupPath, type GitHubRelease } from '../server/check-update.js'

function release(tag: string): GitHubRelease {
  return {
    tag_name: tag,
    html_url: `https://github.com/Milzstream/OBS-Multi-Chat/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `obs-multi-chat-${tag}-windows-x64-setup.exe`, browser_download_url: 'https://example/setup.exe' }],
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
})
