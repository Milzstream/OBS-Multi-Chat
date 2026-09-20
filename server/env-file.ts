import fs from 'node:fs'
import path from 'node:path'

/**
 * Keep the operator's production.env values, and append any keys that a newer
 * `.env.example` added — including commented optional knobs like
 * `# RELAY_ACTIVITY_MAX=5000`. Existing lines are never rewritten.
 */

const KEY_LINE = /^\s*(#\s*)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

export function envKeyFromLine(line: string) {
  const match = line.match(KEY_LINE)
  if (!match) return
  return { key: match[2], commented: Boolean(match[1]) }
}

export function envKeys(text: string) {
  const keys = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const parsed = envKeyFromLine(line)
    if (parsed) keys.add(parsed.key)
  }
  return keys
}

export function envTemplateBlocks(text: string) {
  const blocks: { comments: string[]; key: string; line: string }[] = []
  let pending: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const parsed = envKeyFromLine(line)
    if (!parsed) {
      pending.push(line)
      continue
    }
    blocks.push({ comments: pending, key: parsed.key, line })
    pending = []
  }
  return blocks
}

/** Append template keys that are missing from `existing` (commented or not). */
export function mergeEnvTemplate(existing: string, template: string) {
  const present = envKeys(existing)
  const added: string[] = []
  const extra: string[] = []
  for (const block of envTemplateBlocks(template)) {
    if (present.has(block.key)) continue
    extra.push(...block.comments, block.line)
    present.add(block.key)
    added.push(block.key)
  }
  if (!added.length) return { text: existing, added }
  const nl = existing.includes('\r\n') ? '\r\n' : '\n'
  const body = existing.replace(/\s*$/, '')
  const chunk = extra.join('\n').replace(/^\n+/, '').replace(/\n/g, nl)
  return { text: `${body}${nl}${nl}${chunk}${nl}`, added }
}

export function resolveEnvFilePath(runtimeDir: string, env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env.DOTENV_CONFIG_PATH || '').trim()
  if (configured) return configured
  const production = path.join(runtimeDir, 'production.env')
  if (fs.existsSync(production)) return production
  const dotEnv = path.join(runtimeDir, '.env')
  if (fs.existsSync(dotEnv)) return dotEnv
  return production
}

export function resolveEnvTemplatePath(runtimeDir: string) {
  return path.join(runtimeDir, '.env.example')
}

/**
 * Create the env file from the template if it is missing, otherwise append
 * only keys the operator does not already have (active or commented).
 */
export function syncEnvFile(envPath: string, templatePath: string) {
  if (!fs.existsSync(templatePath)) return { added: [] as string[], written: false }
  const template = fs.readFileSync(templatePath, 'utf8')
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    fs.writeFileSync(envPath, template, { encoding: 'utf8' })
    return { added: [...envKeys(template)], written: true }
  }
  const existing = fs.readFileSync(envPath, 'utf8')
  const merged = mergeEnvTemplate(existing, template)
  if (!merged.added.length) return { added: [] as string[], written: false }
  fs.writeFileSync(envPath, merged.text, { encoding: 'utf8' })
  return { added: merged.added, written: true }
}
