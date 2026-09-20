import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkForUpdates, type GitHubRelease } from '../server/check-update.js'

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
    assert.equal(started[0], 'download')
    assert.equal(started[1], path.join(os.tmpdir(), 'obs-multi-chat-0.6.2-setup.exe'))
    assert.equal(started[2], 'exit')
  })
})
