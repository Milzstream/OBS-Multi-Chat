import fs from 'node:fs'
import path from 'node:path'
import type { LogLine } from './log-buffer.js'

/**
 * Disk copy of the companion window log. Chat and activity already survive a
 * crash; this file is the trace of token refresh, live checks, and quota lines.
 *
 * Lives next to `production.env`: installer copies use
 * `%LOCALAPPDATA%\Relay Chat Dock\logs\relay.log`, portable copies use
 * `<exe dir>\logs\relay.log`. Rotate at a few megabytes into `relay.log.bak`.
 * Append without fsync so the chat path stays cheap; flush on a timer and
 * again before exit so a hard crash still has the last few seconds.
 */

export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024
export const LOG_FILE_FLUSH_MS = 1_000

/** Same folder as `production.env`, not inside `data\`. */
export function resolveLogFilePath(filesDir: string) {
  return path.join(filesDir, 'logs', 'relay.log')
}

/**
 * Strip credentials that must never land on disk: query tokens, watch cookies,
 * bearer headers, JWTs, and oauth client/access/refresh secrets.
 */
export function redactLogSecrets(text: string) {
  return String(text || '')
    .replace(/([?&](?:token|access_token|refresh_token|code_verifier|code)=)[^&\s"'\\]+/gi, '$1<redacted>')
    .replace(/(\btoken=)[^&\s"'\\]+/gi, '$1<redacted>')
    .replace(/((?:relay_watch|x-relay-token)=)[^;\s"'\\]+/gi, '$1<redacted>')
    .replace(/(\bBearer\s+)[A-Za-z0-9._\-+=/]+/gi, '$1<redacted>')
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '<redacted-jwt>')
    .replace(/\b(client_secret|access_token|refresh_token)\s*[:=]\s*\S+/gi, '$1=<redacted>')
}

export function formatLogFileLine(line: Pick<LogLine, 'time' | 'level' | 'text'>) {
  return `${line.time} ${line.level.toUpperCase()} ${redactLogSecrets(line.text)}\n`
}

type LogFileIo = {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void
  appendFileSync: (file: string, data: string) => void
  statSync: (file: string) => { size: number }
  existsSync: (file: string) => boolean
  rmSync: (file: string, options: { force: boolean }) => void
  renameSync: (from: string, to: string) => void
}

export function createLogFile(input: {
  filePath: string
  maxBytes?: number
  flushMs?: number
  io?: Partial<LogFileIo>
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout }
}) {
  const filePath = input.filePath
  const bak = `${filePath}.bak`
  const maxBytes = input.maxBytes ?? LOG_FILE_MAX_BYTES
  const flushMs = input.flushMs ?? LOG_FILE_FLUSH_MS
  const io: LogFileIo = {
    mkdirSync: input.io?.mkdirSync || ((dir, options) => { fs.mkdirSync(dir, options) }),
    appendFileSync: input.io?.appendFileSync || ((file, data) => { fs.appendFileSync(file, data, { encoding: 'utf8', mode: 0o600 }) }),
    statSync: input.io?.statSync || ((file) => fs.statSync(file)),
    existsSync: input.io?.existsSync || ((file) => fs.existsSync(file)),
    rmSync: input.io?.rmSync || ((file, options) => { fs.rmSync(file, options) }),
    renameSync: input.io?.renameSync || ((from, to) => { fs.renameSync(from, to) }),
  }
  const timers = input.timers || { set: setTimeout, clear: clearTimeout }
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  function fileSize() {
    try {
      if (!io.existsSync(filePath)) return 0
      return io.statSync(filePath).size
    } catch {
      return 0
    }
  }

  function rotateIfNeeded(nextBytes: number) {
    if (fileSize() + nextBytes < maxBytes) return
    try { io.rmSync(bak, { force: true }) } catch { /* ignore */ }
    try { io.renameSync(filePath, bak) } catch {
      try { io.rmSync(filePath, { force: true }) } catch { /* keep appending if both fail */ }
    }
  }

  function flush() {
    if (timer) timers.clear(timer)
    timer = undefined
    const chunk = pending
    pending = ''
    if (!chunk) return
    try { io.mkdirSync(path.dirname(filePath), { recursive: true }) } catch { /* ignore */ }
    rotateIfNeeded(chunk.length)
    try { io.appendFileSync(filePath, chunk) } catch { /* a locked file must not take down the relay */ }
  }

  function schedule() {
    if (timer) return
    timer = timers.set(() => {
      timer = undefined
      flush()
    }, flushMs)
  }

  function writeLine(line: Pick<LogLine, 'time' | 'level' | 'text'>) {
    pending += formatLogFileLine(line)
    if (pending.length >= 32_768) flush()
    else schedule()
  }

  return { writeLine, flush }
}
