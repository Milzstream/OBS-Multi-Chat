import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_NOTES_HEADING, publishedReleaseBody } from '../server/check-update.js'

const generatedPath = process.argv[2]
const outPath = process.argv[3]
if (!generatedPath || !outPath) {
  console.error('usage: prepare-release-notes.ts <generated.md> <out.md>')
  process.exit(1)
}

const dir = path.dirname(fileURLToPath(import.meta.url))
const staticBody = fs.readFileSync(path.join(dir, 'release-body.md'), 'utf8').trimEnd()
const generated = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, 'utf8') : ''
const notes = publishedReleaseBody(generated).trim()
const body = notes ? `${staticBody}\n\n${notes}\n` : `${staticBody}\n`
if (body.includes(LEGACY_NOTES_HEADING)) {
  console.error('release notes still contain the heading that hides the update prompt')
  process.exit(1)
}
fs.writeFileSync(outPath, body)
