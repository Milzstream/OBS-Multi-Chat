import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInstallerInstall } from './obs-docks.js'

/**
 * Startup update check: compares the local `package.json` version against the
 * latest GitHub release. Portable copies log the download URL. Installer
 * copies can prompt, download the setup exe, exit, and let Setup replace the files.
 */

interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets?: { name: string; browser_download_url: string }[]
}

export type UpdateHooks = {
  confirm?: (message: string) => boolean
  download?: (url: string, dest: string) => Promise<void>
  startInstaller?: (setupPath: string) => void
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

export function pickInstallerAsset(assets: { name: string; browser_download_url: string }[] | undefined) {
  if (!assets?.length) return
  const setup = assets.find((asset) => /windows-x64-setup\.exe$/i.test(asset.name))
    || assets.find((asset) => /setup/i.test(asset.name) && /\.exe$/i.test(asset.name))
  return setup?.browser_download_url
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

export function getCurrentVersion(): string {
  const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
  const pathsToTry = versionManifestPaths({ packaged, cwd: process.cwd(), execPath: process.execPath })
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
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show(@'\n${message}\n'@, @'\n${title}\n'@, 'YesNo', 'Question'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }`
  return spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }).status === 0
}

async function downloadFile(url: string, dest: string) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download ${response.status}`)
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
}

function startInstaller(setupPath: string) {
  spawn(setupPath, ['/SILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/FORCECLOSEAPPLICATIONS'], {
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
    const currentVersion = getCurrentVersion()
    const latestRelease = await getLatestGitHubRelease()
    if (!latestRelease || latestRelease.draft) return
    const latestVersion = latestRelease.tag_name
    if (compareVersions(latestVersion, currentVersion) <= 0) return

    const setupUrl = pickInstallerAsset(latestRelease.assets)
    const installerCopy = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg) && isInstallerInstall(process.execPath)

    console.log('')
    console.log('  Update available!')
    console.log(`  Current: ${currentVersion}, Latest: ${latestVersion}`)
    console.log(`  Download: ${latestRelease.html_url}`)
    console.log('')

    if (!installerCopy || !setupUrl) return

    const confirm = hooks.confirm || ((message) => windowsYesNo(message, 'Relay Chat Dock'))
    const message = `Relay Chat Dock ${latestVersion} is available.\n\nDownload and install it now? The companion will close, update, and reopen.\n\nYour production.env and data folder are kept.`
    if (!confirm(message)) return

    const dest = path.join(os.tmpdir(), `obs-multi-chat-${latestVersion.replace(/^v/i, '')}-setup.exe`)
    await (hooks.download || downloadFile)(setupUrl, dest)
    console.log('  Closing so Setup can replace the exe…')
    if (hooks.startInstaller) hooks.startInstaller(dest)
    else {
      startInstaller(dest)
      process.exit(0)
    }
  } catch {
    // Update check is not critical
  }
}
