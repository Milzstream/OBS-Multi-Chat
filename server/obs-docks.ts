import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * OBS custom browser docks live in user.ini (OBS 31+) or global.ini (older)
 * as [BasicWindow] ExtraBrowserDocks — a JSON array of { title, url, uuid }.
 * Match existing docks by URL only (localhost ≡ 127.0.0.1). Never replace
 * other docks. Placement is OBS's job.
 */

export const RELAY_CHAT_TITLE = 'Relay Chat'
export const RELAY_ACTIVITY_TITLE = 'Relay Activity'
export const INSTALLER_MARKER = 'installed.origin'
export const APP_FOLDER_NAME = 'Relay Chat Dock'

export type ObsDock = { title: string; url: string; uuid: string }

export function canonicalDockUrl(raw: string) {
  try {
    const url = new URL(String(raw || '').trim())
    const host = url.hostname === 'localhost' || url.hostname === '::1' ? '127.0.0.1' : url.hostname.toLowerCase()
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${host}:${port}${pathname}`.toLowerCase()
  } catch {
    return String(raw || '').trim().toLowerCase().replace(/\/+$/, '')
  }
}

export function sameDockUrl(left: string, right: string) {
  return canonicalDockUrl(left) === canonicalDockUrl(right)
}

export function relayDockUrls(port = 4173) {
  const base = `http://127.0.0.1:${port}`
  return [
    { title: RELAY_CHAT_TITLE, url: `${base}/` },
    { title: RELAY_ACTIVITY_TITLE, url: `${base}/activity` },
  ]
}

export function parseExtraBrowserDocks(raw: string): ObsDock[] | undefined {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return
    return parsed.filter((item): item is ObsDock => Boolean(item && typeof item === 'object' && typeof (item as ObsDock).url === 'string')).map((item) => ({
      title: String(item.title || 'Dock'),
      url: String(item.url),
      uuid: String(item.uuid || ''),
    }))
  } catch {
    return
  }
}

export function dockUrlPresent(docks: ObsDock[], url: string) {
  return docks.some((dock) => sameDockUrl(dock.url, url))
}

export function mergeRelayDocks(existing: ObsDock[], wanted: { title: string; url: string }[], newUuid = () => crypto.randomBytes(16).toString('hex')) {
  const docks = [...existing]
  const added: ObsDock[] = []
  for (const item of wanted) {
    if (dockUrlPresent(docks, item.url)) continue
    const dock = { title: item.title, url: item.url, uuid: newUuid() }
    docks.push(dock)
    added.push(dock)
  }
  return { docks, added }
}

export function readIniValue(text: string, section: string, key: string) {
  const sectionHeader = `[${section}]`
  const lines = text.split(/\r?\n/)
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = trimmed === sectionHeader
      continue
    }
    if (!inSection) continue
    const match = line.match(/^([^=]+)=(.*)$/)
    if (match && match[1].trim() === key) return match[2]
  }
}

export function writeIniValue(text: string, section: string, key: string, value: string) {
  const sectionHeader = `[${section}]`
  const lines = text.length ? text.split(/\r?\n/) : []
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  let inSection = false
  let sectionStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) {
        lines.splice(i, 0, `${key}=${value}`)
        return lines.join(nl).replace(/\s*$/, '') + nl
      }
      inSection = trimmed === sectionHeader
      if (inSection) sectionStart = i
      continue
    }
    if (!inSection) continue
    const match = lines[i].match(/^([^=]+)=(.*)$/)
    if (match && match[1].trim() === key) {
      lines[i] = `${key}=${value}`
      return lines.join(nl)
    }
  }
  if (inSection) {
    lines.push(`${key}=${value}`)
    return lines.join(nl).replace(/\s*$/, '') + nl
  }
  if (sectionStart < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push(sectionHeader, `${key}=${value}`)
    return lines.join(nl).replace(/\s*$/, '') + nl
  }
  return text
}

export function extraBrowserDocksFile(configDir: string) {
  const user = path.join(configDir, 'user.ini')
  const global = path.join(configDir, 'global.ini')
  if (fs.existsSync(user)) return user
  if (fs.existsSync(global)) return global
  return user
}

export function obsConfigDirCandidates(env: NodeJS.ProcessEnv = process.env, extra: string[] = []) {
  const dirs: string[] = []
  const push = (dir?: string) => {
    if (!dir) return
    const resolved = path.resolve(dir)
    if (!dirs.includes(resolved)) dirs.push(resolved)
  }
  for (const dir of extra) push(dir)
  if (env.APPDATA) push(path.join(env.APPDATA, 'obs-studio'))
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean) as string[]
  for (const root of roots) {
    push(path.join(root, 'obs-studio', 'config', 'obs-studio'))
  }
  const x86 = env['ProgramFiles(x86)']
  if (x86) push(path.join(x86, 'Steam', 'steamapps', 'common', 'obs-studio', 'config', 'obs-studio'))
  return dirs
}

export function resolveObsConfigDir(env: NodeJS.ProcessEnv = process.env, extra: string[] = []) {
  const candidates = obsConfigDirCandidates(env, extra)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'user.ini')) || fs.existsSync(path.join(dir, 'global.ini'))) return dir
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
}

export function missingRelayDockUrls(docks: ObsDock[], port = 4173) {
  return relayDockUrls(port).filter((item) => !dockUrlPresent(docks, item.url))
}

export function applyRelayDocksToIni(iniText: string, port = 4173, newUuid?: () => string) {
  const raw = readIniValue(iniText, 'BasicWindow', 'ExtraBrowserDocks')
  const existing = raw == null ? [] : parseExtraBrowserDocks(raw)
  if (!existing) return { ok: false as const, reason: 'unknown-format' as const, text: iniText, added: [] as ObsDock[] }
  const merged = mergeRelayDocks(existing, relayDockUrls(port), newUuid)
  if (!merged.added.length) return { ok: true as const, reason: 'exists' as const, text: iniText, added: [] as ObsDock[] }
  const text = writeIniValue(iniText, 'BasicWindow', 'ExtraBrowserDocks', JSON.stringify(merged.docks))
  return { ok: true as const, reason: 'added' as const, text, added: merged.added }
}

export function obsProcessRunning(tasklistOutput?: string) {
  const text = tasklistOutput ?? (process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || ''
    : '')
  return /obs64\.exe/i.test(text)
}

export function installRelayObsDocks(options: { configDir?: string; port?: number; extraConfigDirs?: string[] } = {}) {
  const extra = [...(options.extraConfigDirs || [])]
  if (options.configDir) extra.unshift(options.configDir)
  const dir = resolveObsConfigDir(process.env, extra)
  if (!dir) return { status: 'not-found' as const }
  const file = extraBrowserDocksFile(dir)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const applied = applyRelayDocksToIni(text, options.port || 4173)
  if (!applied.ok) return { status: applied.reason, file }
  if (applied.reason === 'added') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, applied.text)
  }
  return { status: applied.reason, file, added: applied.added }
}

export function isInstallerInstall(execPath: string) {
  return fs.existsSync(path.join(path.dirname(execPath), INSTALLER_MARKER))
}

export function operatorFilesDir(input: { packaged: boolean; execPath: string; cwd: string; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env
  if (input.packaged && isInstallerInstall(input.execPath) && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, APP_FOLDER_NAME)
  }
  return input.packaged ? path.dirname(input.execPath) : input.cwd
}
