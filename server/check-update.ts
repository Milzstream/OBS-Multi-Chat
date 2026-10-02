import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInstallerInstall } from './obs-docks.js'

/**
 * Startup update check: compares the local `package.json` version against the
 * latest GitHub release. Portable copies log the download URL. Installer
 * copies can prompt, download the setup exe, exit, and let Setup replace the files.
 */

export type GitHubRelease = {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets?: InstallerAsset[]
}

export type InstallerAsset = { name: string; browser_download_url: string; digest?: string }

export type UpdateHooks = {
  confirm?: (message: string) => boolean
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

function windowsYesNo(message: string, title: string) {
  if (process.platform !== 'win32') return false
  return spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', windowsYesNoCommand(message, title)], { windowsHide: true }).status === 0
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
 * Checks if an update is available. Portable copies log the GitHub URL.
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

    console.log('')
    console.log('  Update available!')
    console.log(`  Current: ${currentVersion}, Latest: ${latestVersion}`)
    console.log(`  Download: ${latestRelease.html_url}`)
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

    const confirm = hooks.confirm || ((message) => windowsYesNo(message, 'Relay Chat Dock'))
    const message = `Relay Chat Dock ${safeReleaseTag(latestVersion)} is available.\n\nDownload and install it now? The companion will close, update, and reopen.\n\nYour production.env and data folder are kept.`
    if (!confirm(message)) return

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
