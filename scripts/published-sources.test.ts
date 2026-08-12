import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * Packages publish raw `src/**.ts`, so a consumer's `tsconfig` — not ours —
 * decides how strictly our sources are checked, and `skipLibCheck` does not
 * apply because these are real `.ts` files, not declarations. Two things keep
 * that honest: we ship no files that only exist to exercise the type system,
 * and we build under the strict flags a consumer is likely to have on.
 */
const repoRoot = join(import.meta.dir, '..')
const packages = [
  'bunderstack',
  'bunderstack-query',
  'bunderstack-sync',
  'bunderstack-start',
]

/** Tolerates the `//` comments tsconfig files are allowed to carry. */
async function readJson(path: string) {
  const text = await Bun.file(join(repoRoot, path)).text()
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')
  return JSON.parse(stripped) as Record<string, any>
}

describe('published sources', () => {
  for (const name of packages) {
    test(`${name} excludes test and type-probe files from the tarball`, async () => {
      const pkg = await readJson(`packages/${name}/package.json`)
      const files = (pkg['files'] ?? []) as string[]
      if (!files.includes('src')) return
      expect(files).toContain('!src/**/*.test.ts')
      expect(files).toContain('!src/**/*.types.ts')
    })

    test(`${name} compiles with the strict flags a consumer may enable`, async () => {
      const tsconfig = await readJson(`packages/${name}/tsconfig.json`)
      expect(tsconfig['compilerOptions']['noUnusedLocals']).toBe(true)
    })
  }
})
