/**
 * Normalize line endings to LF across the repository's text files.
 *
 * Shell round-trips (PowerShell's Set-Content / .NET WriteAllLines) introduce
 * CRLF or mixed endings, which turns every subsequent diff into a whole-file
 * rewrite. Node reads and writes UTF-8 correctly, so the normalization runs here.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SKIP = new Set(['node_modules', '.git', 'preview', '.tmp'])
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.html', '.css'])
const changed = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full)
      continue
    }
    if (!TEXT.has(extname(name)) && name !== '.gitignore') continue
    const source = readFileSync(full, 'utf8')
    const normalized = source.replace(/\r\n/g, '\n')
    if (normalized === source) continue
    writeFileSync(full, normalized, 'utf8')
    changed.push(full.slice(ROOT.length))
  }
}

walk(ROOT)
console.log(changed.length === 0 ? 'all text files already use LF' : `normalized to LF: ${changed.join(', ')}`)
