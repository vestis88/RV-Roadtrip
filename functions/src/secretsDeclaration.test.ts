import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A Cloud Functions v2 function can only read a secret it names in its own
 * `secrets: [...]` declaration — but the code that *reads* the secret is
 * almost never in the same file. `generateExploreHighlights` declared only
 * CLAUDE_API_KEY while a helper three imports away called
 * `googlePlacesApiKey.value()`; every geocode threw, every candidate was
 * dropped by the per-candidate catch, and the traveler got "no stops found"
 * on a route full of real places. Nothing caught it: the file's own imports
 * look complete, tsc and eslint see a valid program, and the unit tests mock
 * the layer that would have failed.
 *
 * So this walks the real import graph instead. For every deployed entry
 * point it collects the secrets reachable through its transitive imports and
 * asserts they're all declared. Over-approximating (a reachable
 * `.value()` call on a branch that never runs) is deliberate: declaring a
 * secret you don't end up needing costs nothing, while missing one fails in
 * production only, and only for the traveler.
 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))

const ENTRY_POINT = /export const (\w+) = (onCall|onRequest|onSchedule|onDocument\w*)\b/g
const SECRET_DEFINITION = /export const (\w+) = defineSecret\('([^']+)'\)/g
const SECRETS_DECLARATION = /secrets:\s*\[([^\]]*)\]/g
const RELATIVE_IMPORT = /from '(\.[^']+)'/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.includes('.test.') ? [path] : []
  })
}

const sources = new Map(
  sourceFiles(SRC_ROOT).map((path) => [path, readFileSync(path, 'utf8')]),
)

/** Local const name (`googlePlacesApiKey`) -> secret name (`GOOGLE_PLACES_API_KEY`). */
const secretsByConstName = new Map<string, string>()
for (const text of sources.values()) {
  for (const [, constName, secretName] of text.matchAll(SECRET_DEFINITION)) {
    secretsByConstName.set(constName, secretName)
  }
}

/** Secrets each file reads itself, ignoring anything it imports. */
function secretsReadDirectlyBy(text: string): Set<string> {
  const found = new Set<string>()
  for (const [constName, secretName] of secretsByConstName) {
    if (new RegExp(`\\b${constName}\\.value\\(\\)`).test(text)) found.add(secretName)
  }
  return found
}

/** Compiled `.js` specifiers back to the `.ts` files they came from. */
function importsOf(path: string, text: string): string[] {
  return [...text.matchAll(RELATIVE_IMPORT)]
    .map(([, specifier]) =>
      resolve(dirname(path), specifier).replace(/\.js$/, '.ts'),
    )
    .filter((resolved) => sources.has(resolved))
}

function secretsReachableFrom(path: string, visited = new Set<string>()): Set<string> {
  if (visited.has(path)) return new Set()
  visited.add(path)
  const text = sources.get(path)!
  const reachable = secretsReadDirectlyBy(text)
  for (const dependency of importsOf(path, text)) {
    for (const secret of secretsReachableFrom(dependency, visited)) {
      reachable.add(secret)
    }
  }
  return reachable
}

function declaredSecretsIn(text: string): Set<string> {
  const declared = new Set<string>()
  for (const [, list] of text.matchAll(SECRETS_DECLARATION)) {
    for (const constName of list.split(',').map((part) => part.trim()).filter(Boolean)) {
      declared.add(secretsByConstName.get(constName) ?? constName)
    }
  }
  return declared
}

const entryPoints = [...sources]
  .map(([path, text]) => ({
    path,
    text,
    names: [...text.matchAll(ENTRY_POINT)].map(([, name]) => name),
  }))
  .filter((file) => file.names.length > 0)

describe('Cloud Function secret declarations', () => {
  it('finds the deployed entry points at all (guards the parsing above)', () => {
    const allNames = entryPoints.flatMap((file) => file.names)
    expect(allNames).toContain('generateExploreHighlights')
    expect(allNames).toContain('generatePlan')
    expect(secretsByConstName.size).toBeGreaterThan(0)
  })

  it.each(entryPoints.map((file) => [file.names.join(', '), file] as const))(
    '%s declares every secret its imports can reach',
    (_names, file) => {
      const declared = declaredSecretsIn(file.text)
      const reachable = secretsReachableFrom(file.path)
      const missing = [...reachable].filter((secret) => !declared.has(secret))
      expect(missing).toEqual([])
    },
  )
})
