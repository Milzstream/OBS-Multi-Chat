import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(root, 'tests')
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testsDir, name))
  .sort()

if (!files.length) {
  console.error('No tests/*.test.ts files found')
  process.exit(1)
}

const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
