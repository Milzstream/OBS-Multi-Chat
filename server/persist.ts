import fs from 'node:fs'
import path from 'node:path'
import { operatorFilesDir } from './obs-docks.js'

/**
 * Durable JSON persistence for the server: resolves the data directory
 * (`RELAY_DATA_DIR`, or `<cwd>/data`, or beside the packaged binary) and writes
 * files atomically — tmp file + fsync + rename — with a `.bak` copy of the
 * previous good file so a crash mid-write is recoverable.
 */

/** `RELAY_DATA_DIR` wins; otherwise installer copies use LocalAppData, portable beside the exe, dev under cwd. */
export function resolveDataDir(input: {
  packaged?: boolean
  execPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
} = {}) {
  const env = input.env ?? process.env
  const configured = String(env.RELAY_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  const packaged = input.packaged ?? Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
  const execPath = input.execPath ?? process.execPath
  const cwd = input.cwd ?? process.cwd()
  return path.join(operatorFilesDir({ packaged, execPath, cwd, env }), 'data')
}

/**
 * Write JSON atomically: write tmp, fsync, then rename over the target so
 * readers never see a half-written file. The existing good file is renamed to
 * `.bak` first (it is re-validated as parseable JSON) so the last-known-good
 * copy survives a failed rename.
 */
type JsonReplaceIo = {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: BufferEncoding) => string
  rmSync: (path: string, options?: { force?: boolean }) => void
  renameSync: (from: string, to: string) => void
  copyFileSync: (from: string, to: string) => void
}

/**
 * Move the previous file aside, then rename the temp into place. A failed
 * backup must not delete the live file; overwrite it by copy instead.
 */
export function commitJsonReplace(filePath: string, tmp: string, bak: string, io: JsonReplaceIo = fs): boolean {
  let movedAside = !io.existsSync(filePath)
  if (!movedAside) {
    try {
      JSON.parse(io.readFileSync(filePath, 'utf8'))
      io.rmSync(bak, { force: true })
      io.renameSync(filePath, bak)
      movedAside = true
    } catch {
      movedAside = false
    }
  }
  if (movedAside) {
    io.renameSync(tmp, filePath)
    return true
  }
  try {
    io.copyFileSync(tmp, filePath)
    io.rmSync(tmp, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Coalesce bursty writes. `schedule` is a no-op while a flush is already
 * waiting; `flush` writes immediately and is what shutdown must call so the
 * last second of chat is not left only in memory.
 */
export function createDebouncedSave(save: () => void, waitMs = 1000, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer) timers.clear(timer)
    timer = undefined
    if (!dirty) return
    dirty = false
    save()
  }
  function schedule() {
    dirty = true
    if (timer) return
    timer = timers.set(() => {
      timer = undefined
      flush()
    }, waitMs)
  }
  return { schedule, flush }
}

export function writeJsonAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  const bak = `${filePath}.bak`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    const fd = fs.openSync(tmp, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch {
    // fsync is best-effort on filesystems that do not support it
  }
  if (!commitJsonReplace(filePath, tmp, bak)) {
    throw new Error(`Could not replace ${filePath}`)
  }
}

/**
 * Read back a JSON file, falling back to the `.bak` copy if the main file is
 * missing or corrupted, and finally to the supplied `fallback` value.
 */
export function readJsonFile<T>(filePath: string, fallback: T, revive?: (value: unknown) => T): T {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      if (!fs.existsSync(candidate)) continue
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown
      return revive ? revive(parsed) : parsed as T
    } catch {
      continue
    }
  }
  return fallback
}
