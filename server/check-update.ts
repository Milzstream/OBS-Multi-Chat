import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInstallerInstall } from './obs-docks.js'

/**
 * Startup update check: compares the local `package.json` version against the
 * latest GitHub release. Portable copies log the download URL and release notes.
 * Installer copies can prompt, download the setup exe, exit, and let Setup replace the files.
 */

export type GitHubRelease = {
  tag_name: string
  html_url: string
  body?: string | null
  draft: boolean
  prerelease: boolean
  assets?: InstallerAsset[]
}

export type InstallerAsset = { name: string; browser_download_url: string; digest?: string }

export type UpdateHooks = {
  confirm?: (message: string) => boolean | Promise<boolean>
  download?: (url: string, dest: string) => Promise<void>
  startInstaller?: (setupPath: string) => void
  currentVersion?: string
  latestRelease?: GitHubRelease | null
  installerCopy?: boolean
  exit?: () => void
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((part) => {
      const num = parseInt(part, 10)
      return isNaN(num) ? 0 : num
    })
}

/** Returns 1 if version1 > version2, -1 if version1 < version2, 0 if equal. */
export function compareVersions(version1: string, version2: string): number {
  const v1 = parseVersion(version1)
  const v2 = parseVersion(version2)
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const part1 = v1[i] ?? 0
    const part2 = v2[i] ?? 0
    if (part1 > part2) return 1
    if (part1 < part2) return -1
  }
  return 0
}

export function pickInstallerAssetRecord(assets: InstallerAsset[] | undefined) {
  if (!assets?.length) return
  return assets.find((asset) => /windows-x64-setup\.exe$/i.test(asset.name))
    || assets.find((asset) => /setup/i.test(asset.name) && /\.exe$/i.test(asset.name))
}

export function pickInstallerAsset(assets: InstallerAsset[] | undefined) {
  return pickInstallerAssetRecord(assets)?.browser_download_url
}

/** Tags are filenames. Strip anything that `path.join` would treat as a directory. */
export function safeReleaseTag(tag: string) {
  const cleaned = tag.replace(/^v/i, '').replace(/[^A-Za-z0-9._-]/g, '')
  return cleaned || 'update'
}

export function installerSetupPath(tag: string, tmpDir = os.tmpdir()) {
  const dest = path.resolve(tmpDir, `obs-multi-chat-${safeReleaseTag(tag)}-setup.exe`)
  const relative = path.relative(path.resolve(tmpDir), dest)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('update path escaped temp')
  return dest
}

/** Setup binaries only come from GitHub release hosts, over HTTPS. */
export function installerDownloadAllowed(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'github.com' || host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com' || host.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

/** Break a PowerShell here-string terminator so a release tag cannot run as code. */
export function escapePowerShellHereString(value: string) {
  return value.replace(/'@/g, "' @")
}

export function windowsYesNoCommand(message: string, title: string) {
  const body = escapePowerShellHereString(message)
  const caption = escapePowerShellHereString(title)
  return `Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show(@'\n${body}\n'@, @'\n${caption}\n'@, 'YesNo', 'Question'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }`
}

export const RELEASE_NOTES_EXCERPT_MAX = 4000

export function releaseNotesExcerpt(body: string | null | undefined, maxLength = RELEASE_NOTES_EXCERPT_MAX) {
  if (!body) return ''
  const at = body.indexOf("## What's Changed")
  if (at < 0) return ''
  let text = body.slice(at).replace(/\r\n/g, '\n')
  text = text.replace(/^#{1,6}[ \t]+/gm, '')
  text = text.replace(/\*\*(.+?)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.trim()
  if (!text || text === "What's Changed") return ''
  if (text.length <= maxLength) return text
  const cut = text.slice(0, maxLength)
  const line = cut.lastIndexOf('\n')
  const trimmed = (line > maxLength * 0.6 ? cut.slice(0, line) : cut).trimEnd()
  return `${trimmed}\n…`
}

export function updateAvailableMessage(version: string) {
  return `Relay Chat Dock ${safeReleaseTag(version)} is available.\n\nDownload and install it now? The companion will close, update, and reopen.\n\nYour production.env and data folder are kept.`
}

export function updatePromptMessage(version: string, htmlUrl: string, excerpt: string) {
  const base = updateAvailableMessage(version)
  if (!excerpt) return base
  return `${base}\n\n${excerpt}\n\nFull notes: ${htmlUrl}`
}

export function releaseNotesFileText(excerpt: string, htmlUrl: string) {
  return `Full notes: ${htmlUrl}\n\n${excerpt}`
}

export function releaseNotesPath(tag: string, tmpDir = os.tmpdir(), suffix = '') {
  const extra = suffix.replace(/[^A-Za-z0-9._-]/g, '')
  const name = `obs-multi-chat-${safeReleaseTag(tag)}${extra ? `-${extra}` : ''}-notes.txt`
  const dest = path.resolve(tmpDir, name)
  const relative = path.relative(path.resolve(tmpDir), dest)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('notes path escaped temp')
  return dest
}

export function windowsReleaseNotesCommand(message: string, title: string, notesPath: string) {
  const body = escapePowerShellHereString(message)
  const caption = escapePowerShellHereString(title)
  const file = escapePowerShellHereString(notesPath)
  return `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notes = [System.IO.File]::ReadAllText(@'
${file}
'@, [System.Text.UTF8Encoding]::new($false))
$lf = [string][char]10
$crlf = [string][char]13 + $lf
$notes = $notes.Replace($crlf, $lf).Replace($lf, $crlf)
$form = New-Object System.Windows.Forms.Form
$form.Text = @'
${caption}
'@
$form.FormBorderStyle = 'FixedDialog'
$form.StartPosition = 'CenterScreen'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(520, 460)
$label = New-Object System.Windows.Forms.Label
$label.Text = @'
${body}
'@
$label.Location = New-Object System.Drawing.Point(12, 12)
$label.Size = New-Object System.Drawing.Size(496, 110)
$box = New-Object System.Windows.Forms.Panel
$box.AutoScroll = $true
$box.BorderStyle = 'Fixed3D'
$box.BackColor = [System.Drawing.SystemColors]::Window
$box.Location = New-Object System.Drawing.Point(12, 130)
$box.Size = New-Object System.Drawing.Size(496, 274)
$box.TabStop = $true
$notesText = New-Object System.Windows.Forms.Label
$notesText.AutoSize = $true
$notesText.MaximumSize = New-Object System.Drawing.Size(460, 0)
$notesText.Location = New-Object System.Drawing.Point(4, 4)
$notesText.UseMnemonic = $false
$notesText.BackColor = [System.Drawing.SystemColors]::Window
$notesText.Text = $notes
$box.Controls.Add($notesText)
$box.Add_MouseEnter({ $box.Focus() })
$notesText.Add_MouseEnter({ $box.Focus() })
$yes = New-Object System.Windows.Forms.Button
$yes.Text = 'Yes'
$yes.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$yes.Location = New-Object System.Drawing.Point(320, 416)
$no = New-Object System.Windows.Forms.Button
$no.Text = 'No'
$no.DialogResult = [System.Windows.Forms.DialogResult]::No
$no.Location = New-Object System.Drawing.Point(408, 416)
$form.AcceptButton = $yes
$form.CancelButton = $no
$form.Controls.AddRange(@($label, $box, $yes, $no))
$form.ActiveControl = $yes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RelayUpdateNative {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$null = $form.Handle
[RelayUpdateNative]::ShowWindow($form.Handle, 0) | Out-Null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  $timer.Stop()
  [RelayUpdateNative]::ShowWindow($form.Handle, 5) | Out-Null
  $form.Visible = $true
  $form.Activate()
  [RelayUpdateNative]::SetForegroundWindow($form.Handle) | Out-Null
})
$timer.Start()
$r = $form.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }`
}

export function digestMatches(body: Buffer, digest?: string) {
  const match = String(digest || '').match(/^sha256:([a-f0-9]{64})$/i)
  if (!match) return false
  const actual = crypto.createHash('sha256').update(body).digest('hex')
  return actual.toLowerCase() === match[1].toLowerCase()
}

export function versionManifestPaths(input: { packaged: boolean; cwd: string; execPath: string }) {
  if (input.packaged) {
    return [
      path.join(path.dirname(input.execPath), 'package.json'),
      path.join(input.cwd, 'package.json'),
    ]
  }
  return [
    path.join(input.cwd, 'package.json'),
    path.join(input.cwd, '..', 'package.json'),
    path.join(input.cwd, '../..', 'package.json'),
    path.join(path.dirname(input.execPath), 'package.json'),
  ]
}

export function isDesktopPackaged() {
  const proc = process as NodeJS.Process & { pkg?: unknown; defaultApp?: boolean }
  return Boolean(proc.pkg) || process.env.RELAY_PACKAGED === '1' || (Boolean(process.versions?.electron) && !proc.defaultApp)
}

export function getCurrentVersion(): string {
  const packaged = isDesktopPackaged()
  const pathsToTry = versionManifestPaths({ packaged, cwd: process.cwd(), execPath: process.execPath })
  if (process.env.RELAY_APP_ROOT) pathsToTry.unshift(path.join(process.env.RELAY_APP_ROOT, 'package.json'))
  for (const filePath of pathsToTry) {
    try {
      if (fs.existsSync(filePath)) {
        const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (packageJson.version) return packageJson.version
      }
    } catch {
      // Try next path
    }
  }
  return '0.0.0'
}

async function getLatestGitHubRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch('https://api.github.com/repos/Milzstream/OBS-Multi-Chat/releases/latest')
    if (!response.ok) return null
    return await response.json() as GitHubRelease
  } catch {
    return null
  }
}

type YesNoSpawn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: 'ignore' },
) => { on(event: string, listener: (...args: any[]) => void): unknown }

export function confirmWithSpawn(spawnImpl: YesNoSpawn, message: string, title: string, command = windowsYesNoCommand(message, title)) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (yes: boolean) => {
      if (settled) return
      settled = true
      resolve(yes)
    }
    try {
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-STA', '-Command', command], { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
    } catch {
      finish(false)
    }
  })
}

function windowsYesNo(message: string, title: string) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return confirmWithSpawn((command, args, options) => spawn(command, args, options), message, title)
}

function confirmReleaseNotes(label: string, title: string, tag: string, notesText: string) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  let notesPath: string
  try {
    notesPath = releaseNotesPath(tag, os.tmpdir(), crypto.randomBytes(4).toString('hex'))
    fs.writeFileSync(notesPath, notesText, 'utf8')
  } catch {
    return windowsYesNo(label, title)
  }
  return confirmWithSpawn(
    (command, args, options) => spawn(command, args, options),
    label,
    title,
    windowsReleaseNotesCommand(label, title, notesPath),
  ).finally(() => {
    fs.rmSync(notesPath, { force: true })
  })
}

async function downloadFile(url: string, dest: string) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download ${response.status}`)
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
}

export function silentSetupArgs() {
  return ['/SILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/FORCECLOSEAPPLICATIONS', '/TASKS=!addobsdocks']
}

export function silentRelaunchPowershell(exePath: string, workingDir: string) {
  const exe = exePath.replace(/'/g, "''")
  const dir = workingDir.replace(/'/g, "''")
  return `[void]([wmiclass]'Win32_Process').Create('"${exe}"','${dir}')`
}

function startInstaller(setupPath: string) {
  spawn(setupPath, silentSetupArgs(), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}

/**
 * Checks if an update is available. Portable copies log the GitHub URL and notes.
 * Installer copies prompt once, then download setup, exit, and let Setup relaunch.
 */
export async function checkForUpdates(hooks: UpdateHooks = {}): Promise<void> {
  try {
    const currentVersion = hooks.currentVersion ?? getCurrentVersion()
    const latestRelease = hooks.latestRelease !== undefined ? hooks.latestRelease : await getLatestGitHubRelease()
    if (!latestRelease || latestRelease.draft) return
    const latestVersion = latestRelease.tag_name
    if (compareVersions(latestVersion, currentVersion) <= 0) return

    const setupAsset = pickInstallerAssetRecord(latestRelease.assets)
    const setupUrl = setupAsset?.browser_download_url
    const installerCopy = hooks.installerCopy ?? (isDesktopPackaged() && isInstallerInstall(process.execPath))
    const excerpt = releaseNotesExcerpt(latestRelease.body)

    console.log('')
    console.log('  Update available!')
    console.log(`  Current: ${currentVersion}, Latest: ${latestVersion}`)
    console.log(`  Download: ${latestRelease.html_url}`)
    if (excerpt) {
      console.log('')
      for (const line of excerpt.split('\n')) console.log(`  ${line}`)
    }
    console.log('')

    if (!installerCopy || !setupUrl) return
    if (!installerDownloadAllowed(setupUrl)) {
      console.log('  Installer update skipped: asset URL is not a GitHub release.')
      return
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(setupAsset?.digest || '')) {
      console.log('  Installer update skipped: release asset has no sha256 digest.')
      return
    }

    const message = updatePromptMessage(latestVersion, latestRelease.html_url, excerpt)
    const confirm = hooks.confirm || ((prompt) => {
      if (!excerpt) return windowsYesNo(prompt, 'Relay Chat Dock')
      return confirmReleaseNotes(updateAvailableMessage(latestVersion), 'Relay Chat Dock', latestVersion, releaseNotesFileText(excerpt, latestRelease.html_url))
    })
    if (!(await confirm(message))) return

    const dest = installerSetupPath(latestVersion)
    await (hooks.download || downloadFile)(setupUrl, dest)
    if (!digestMatches(fs.readFileSync(dest), setupAsset?.digest)) {
      console.error('  Update skipped: installer digest did not match.')
      fs.rmSync(dest, { force: true })
      return
    }
    console.log('  Closing so Setup can replace the exe…')
    if (hooks.startInstaller) hooks.startInstaller(dest)
    else startInstaller(dest)
    if (hooks.exit) hooks.exit()
    else process.exit(0)
  } catch {
    // Update check is not critical
  }
}
