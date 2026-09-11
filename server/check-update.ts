import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
}

/**
 * Parses a semantic version string into comparable numbers
 * "0.3.9" -> [0, 3, 9]
 */
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, '') // Remove leading 'v' if present
    .split('.')
    .map((part) => {
      const num = parseInt(part, 10)
      return isNaN(num) ? 0 : num
    })
}

/**
 * Compares two semantic versions
 * Returns: 1 if version1 > version2, -1 if version1 < version2, 0 if equal
 */
function compareVersions(version1: string, version2: string): number {
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

/**
 * Gets the current version from package.json
 */
function getCurrentVersion(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const packageJsonPath = path.join(__dirname, '..', 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
  return packageJson.version || '0.0.0'
}

/**
 * Fetches the latest release from GitHub
 */
async function getLatestGitHubRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch('https://api.github.com/repos/Milzstream/OBS-Multi-Chat/releases/latest')
    if (!response.ok) return null
    const data = (await response.json()) as GitHubRelease
    return data
  } catch (error) {
    // Silently fail if we can't reach GitHub
    return null
  }
}

/**
 * Checks if an update is available and logs it to console
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const currentVersion = getCurrentVersion()
    const latestRelease = await getLatestGitHubRelease()

    if (!latestRelease || latestRelease.draft) return

    const latestVersion = latestRelease.tag_name
    const comparison = compareVersions(latestVersion, currentVersion)

    if (comparison > 0) {
      console.log('')
      console.log('  Update available!')
      console.log(`  Current: ${currentVersion}, Latest: ${latestVersion}`)
      console.log(`  Download: ${latestRelease.html_url}`)
      console.log('')
    }
  } catch (error) {
    // Silently fail - update check is not critical
  }
}
