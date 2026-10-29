/**
 * Installed overlay fonts for Customize. Lists this PC's families (system
 * plus per-user) so OBS on the same machine can render the same CSS name.
 */

import { execFile } from 'node:child_process'
import type { Express, Request, Response } from 'express'
import { ALERT_FONTS, mergeAlertFontList } from './logic/alert-looks.js'

const ALERT_FONT_LIST_MS = 8_000
const ALERT_FONT_LIST_BUFFER = 2 * 1024 * 1024

export type AlertFontExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding?: BufferEncoding; maxBuffer?: number },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown

let cached: Promise<string[]> | undefined

/** GDI+ families include fonts this user installed, not only C:\Windows\Fonts. */
export function windowsInstalledFontsPlan() {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'Add-Type -AssemblyName System.Drawing',
    '$names = [System.Drawing.Text.InstalledFontCollection]::new().Families | ForEach-Object Name',
    'ConvertTo-Json -Compress @($names)',
  ].join('; ')
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  }
}

export function parseInstalledFontOutput(stdout: string): string[] {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    const names = Array.isArray(parsed) ? parsed : [parsed]
    return names.filter((name): name is string => typeof name === 'string')
  } catch {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  }
}

export function resetAlertFontCache() {
  cached = undefined
}

function collectInstalledFonts(run: AlertFontExecFile): Promise<string[]> {
  const plan = windowsInstalledFontsPlan()
  return new Promise((resolve, reject) => {
    try {
      run(plan.command, plan.args, {
        timeout: ALERT_FONT_LIST_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: ALERT_FONT_LIST_BUFFER,
      }, (error, stdout) => {
        if (error) reject(error)
        else resolve(parseInstalledFontOutput(String(stdout || '')))
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Family names Windows reports. Sanitizing and Outfit-first ordering happen
 * in `mergeAlertFontList`. Tests pass `run` so they never spawn.
 */
export function listInstalledAlertFonts(run?: AlertFontExecFile): Promise<string[]> {
  if (run) return collectInstalledFonts(run)
  if (process.platform !== 'win32') return Promise.resolve([])
  if (!cached) {
    cached = collectInstalledFonts(execFile as unknown as AlertFontExecFile).catch((error) => {
      cached = undefined
      throw error
    })
  }
  return cached
}

function fallbackAlertFonts() {
  return [...ALERT_FONTS]
}

export function registerAlertFontRoutes(app: Express, options?: { list?: () => Promise<string[]> }) {
  app.get('/api/alerts/fonts', async (_request: Request, response: Response) => {
    try {
      const installed = await (options?.list || listInstalledAlertFonts)()
      const fonts = mergeAlertFontList(installed)
      response.json({ fonts: fonts.length > 1 ? fonts : fallbackAlertFonts() })
    } catch {
      response.json({ fonts: fallbackAlertFonts() })
    }
  })
}
