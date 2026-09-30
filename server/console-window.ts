import path from 'node:path'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'

export const COMPANION_EXE = 'relay-chat-dock-window.exe'

export function findCompanionExe(dirs: string[], exists: (file: string) => boolean) {
  for (const dir of dirs) {
    const file = path.join(dir, COMPANION_EXE)
    if (exists(file)) return file
  }
}

export function nativeWindowPlan(exe: string, url: string) {
  return {
    command: exe,
    args: ['--url', url],
    options: { stdio: 'ignore' as const, windowsHide: true },
  }
}

export function serverShouldOpenWindow(input: { packaged: boolean; platform: string; argv: string[]; env: NodeJS.ProcessEnv }) {
  if (input.env.RELAY_ELECTRON === '1') return false
  return shouldOpenConsoleWindow(input)
}

export function shouldOpenConsoleWindow(input: { packaged: boolean; platform: string; argv: string[]; env: NodeJS.ProcessEnv }) {
  if (input.argv.includes('--no-window') || input.argv.includes('--add-obs-docks')) return false
  if (input.env.RELAY_NO_WINDOW === '1') return false
  if (input.env.RELAY_CONSOLE_WINDOW === '1') return true
  return input.packaged && input.platform === 'win32'
}

export function appBrowserCandidates(env: NodeJS.ProcessEnv) {
  const programFiles = env.PROGRAMFILES || ''
  const programFilesX86 = env['PROGRAMFILES(X86)'] || ''
  const local = env.LOCALAPPDATA || ''
  return [
    env.BROWSER_PATH,
    programFiles && path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((item): item is string => Boolean(item))
}

export function findAppBrowser(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = () => false) {
  return appBrowserCandidates(env).find((file) => exists(file))
}

export function consoleWindowPlan(exe: string, url: string, profileDir: string) {
  return {
    command: exe,
    args: [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-component-update',
      '--disable-features=Translate,msEdgeWelcomePage,EdgeSync,SignInPromo',
      '--hide-crash-restore-bubble',
      '--noerrdialogs',
      '--window-size=1100,740',
    ],
    options: { detached: true, stdio: 'ignore' as const, windowsHide: true },
  }
}

export function consoleProfileCleanupPlan(profileDir: string) {
  const marker = profileDir.replace(/'@/g, "' @")
  const ps = `Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(@'\n${marker}\n'@) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  return { command: 'powershell.exe', args: ['-NoProfile', '-Command', ps] }
}

export function windowsMessageBoxPlan(message: string, title: string) {
  const body = message.replace(/'@/g, "' @")
  const caption = title.replace(/'@/g, "' @")
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(@'\n${body}\n'@, @'\n${caption}\n'@, 'OK', 'Information')`
  return { command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', ps], options: { windowsHide: true } as SpawnSyncOptions }
}

export function windowsMessageBox(message: string, title: string, run: typeof spawnSync = spawnSync) {
  if (process.platform !== 'win32') return
  const plan = windowsMessageBoxPlan(message, title)
  try { run(plan.command, plan.args, plan.options) } catch { /* ignore */ }
}

export function createHostSession(exit: () => void, graceMs = 2000, schedule: typeof setTimeout = setTimeout, cancel: typeof clearTimeout = clearTimeout) {
  let armed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    hello() {
      armed = true
      if (timer) cancel(timer)
      timer = undefined
    },
    bye() {
      if (!armed) return false
      if (timer) cancel(timer)
      timer = schedule(() => {
        timer = undefined
        exit()
      }, graceMs)
      return true
    },
    get pending() {
      return Boolean(timer)
    },
  }
}
