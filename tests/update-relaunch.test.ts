import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { pickInstallerAsset, silentRelaunchPowershell, silentSetupArgs } from '../server/check-update.js'

const iss = fs.readFileSync(path.resolve('installer/relay-chat-dock.iss'), 'utf8')

describe('silent setup args', () => {
  it('runs silent, force-closes, and does not rewrite OBS docks', () => {
    const args = silentSetupArgs()
    assert.ok(args.includes('/SILENT'))
    assert.ok(args.includes('/NORESTART'))
    assert.ok(args.includes('/SUPPRESSMSGBOXES'))
    assert.ok(args.includes('/FORCECLOSEAPPLICATIONS'))
    assert.ok(args.includes('/TASKS=!addobsdocks'))
    assert.equal(pickInstallerAsset([
      { name: 'obs-multi-chat-v0.6.2-windows-x64-setup.exe', browser_download_url: 'https://example/setup.exe' },
    ]), 'https://example/setup.exe')
  })
})

describe('silent relaunch command', () => {
  it('uses WMI Create so the new exe is not a child of Setup', () => {
    const cmd = silentRelaunchPowershell('C:\\Program Files\\Relay Chat Dock\\relay-chat-dock.exe', 'C:\\Program Files\\Relay Chat Dock')
    assert.equal(cmd, `[void]([wmiclass]'Win32_Process').Create('"C:\\Program Files\\Relay Chat Dock\\relay-chat-dock.exe"','C:\\Program Files\\Relay Chat Dock')`)
  })
})

describe('installer script', () => {
  it('relaunches via WMI on silent installs and does not add docks or ShellExec the exe', () => {
    assert.match(iss, /if WizardSilent then/)
    assert.match(iss, /Win32_Process/)
    assert.match(iss, /else if WizardIsTaskSelected\('addobsdocks'\)/)
    assert.doesNotMatch(iss, /ShellExecAsOriginalUser/)
    assert.doesNotMatch(iss, /skipifnotsilent/)
  })
})
