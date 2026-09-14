import fs from 'node:fs'
import path from 'node:path'

/**
 * Durable JSON persistence for the server: resolves the data directory
 * (`RELAY_DATA_DIR`, or `<cwd>/data`, or beside the packaged binary) and writes
 * files atomically — tmp file + fsync + rename — with a `.bak` copy of the
 * previous good file so a crash mid-write is recoverable.
 */

/** `RELAY_DATA_DIR` wins; otherwise packaged builds store next to the exe, dev builds under cwd. */
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
  return path.resolve(packaged ? path.dirname(execPath) : cwd, 'data')
}

/**
 * Write JSON atomically: write tmp, fsync, then rename over the target so
 * readers never see a half-written file. The existing good file is renamed to
 * `.bak` first (it is re-validated as parseable JSON) so the last-known-good
 * copy survives a failed rename.
 */
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
  if (fs.existsSync(filePath)) {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'))
      fs.rmSync(bak, { force: true })
      fs.renameSync(filePath, bak)
    } catch {
      fs.rmSync(filePath, { force: true })
    }
  }
  fs.renameSync(tmp, filePath)
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
