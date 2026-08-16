import { readFileSync } from 'node:fs'

/**
 * Argument and key handling shared by the debug entry points.
 *
 * Extracted when the rescan tool joined the curation one (2026-08-16) —
 * both need the same key file and the same tolerance for how npm mangles
 * forwarded arguments, and a second hand-rolled copy of either is a second
 * thing to get subtly wrong.
 */
/**
 * Both keys are read the way the deployed functions read them — through
 * firebase-functions' `defineSecret(...).value()`, which falls back to
 * process.env outside a deployed runtime. So this file only has to get them
 * INTO the environment, and nothing in the pipeline needs a test-only branch.
 *
 * The file is gitignored (`.env.*`). Deliberately a file rather than a flag:
 * a key pasted onto a command line ends up in shell history and in any
 * transcript of the session.
 */
export function loadEnvFile(name: string): void {
  // Searched upward from the working directory because npm runs a workspace
  // script with cwd set to that workspace: invoked from the repo root, this
  // process starts in functions/, and the key file lives beside the repo's
  // other env files at the top. Looking in one place would mean silently
  // finding nothing and reporting "no key" while the key sat one level up.
  let contents: string | undefined
  for (const prefix of ['', '../', '../../']) {
    try {
      contents = readFileSync(`${prefix}${name}`, 'utf8')
      break
    } catch {
      continue
    }
  }
  if (contents === undefined) return
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (value) process.env[match[1]] ??= value
  }
}

/**
 * Everything between this flag and the next one, rejoined.
 *
 * Not just the next token: npm drops the quotes when forwarding args through
 * `npm run … --`, so `--to "Sundsvall, Sweden"` arrives as three separate
 * argv entries and reading one of them silently plans a trip to "Sundsvall,".
 * Silently is the problem — the run costs a Claude call and looks fine.
 */
export function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const rest = process.argv.slice(index + 1)
  const end = rest.findIndex((token) => token.startsWith('--'))
  const value = (end < 0 ? rest : rest.slice(0, end)).join(' ').trim()
  return value || fallback
}

export function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`)
}

