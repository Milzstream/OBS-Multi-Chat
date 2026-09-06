import fs from 'node:fs'
import path from 'node:path'

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
