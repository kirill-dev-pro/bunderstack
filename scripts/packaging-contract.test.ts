import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * Packages publish built `dist` — JS plus declarations — so a consumer's
 * `tsconfig` checks our `.d.ts` (which `skipLibCheck` can suppress) instead of
 * our sources (which it cannot). These tests pin the packaging contract; the
 * end-to-end proof that a strict consumer sees nothing from us lives in
 * `scripts/verify-consumer.ts`.
 */
const repoRoot = join(import.meta.dir, '..')
const packages = [
  'bunderstack',
  'bunderstack-client',
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

describe('published packages', () => {
  for (const name of packages) {
    test(`${name} ships dist and no sources`, async () => {
      const pkg = await readJson(`packages/${name}/package.json`)
      const files = (pkg['files'] ?? []) as string[]
      expect(files).toContain('dist')
      expect(files).not.toContain('src')
      expect(pkg['main']).toMatch(/^\.\/dist\//)
      expect(pkg['types']).toMatch(/^\.\/dist\/.*\.d\.ts$/)
    })

    test(`${name} declares types next to every entry point`, async () => {
      const pkg = await readJson(`packages/${name}/package.json`)
      for (const [subpath, target] of Object.entries(
        pkg['exports'] as Record<string, { types?: string; default?: string }>,
      )) {
        expect(target, subpath).toMatchObject({
          types: expect.stringMatching(/^\.\/dist\/.*\.d\.ts$/),
          default: expect.stringMatching(/^\.\/dist\/.*\.js$/),
        })
      }
    })

    test(`${name} builds before it is packed`, async () => {
      const pkg = await readJson(`packages/${name}/package.json`)
      expect(pkg['scripts']['build']).toContain('build-package.ts')
      expect(pkg['scripts']['prepack']).toBe('bun run build')
    })

    test(`${name} compiles with the strict flags a consumer may enable`, async () => {
      const tsconfig = await readJson(`packages/${name}/tsconfig.json`)
      for (const flag of [
        'noUnusedLocals',
        'noUnusedParameters',
        'noImplicitReturns',
      ]) {
        expect(tsconfig['compilerOptions'][flag], flag).toBe(true)
      }
    })

    test(`${name} keeps tests and type probes out of the build`, async () => {
      const tsconfig = await readJson(`packages/${name}/tsconfig.build.json`)
      expect(tsconfig['exclude']).toEqual([
        'src/**/*.test.ts',
        'src/**/*.types.ts',
      ])
      expect(tsconfig['compilerOptions']['declaration']).toBe(true)
      expect(tsconfig['compilerOptions']['sourceMap']).toBe(true)
      expect(tsconfig['compilerOptions']['inlineSources']).toBe(true)
      expect(tsconfig['compilerOptions']['outDir']).toBe('dist')
    })

    test(`${name} README links resolve outside the repo`, async () => {
      const readme = await Bun.file(
        join(repoRoot, `packages/${name}/README.md`),
      ).text()
      // A tarball has no parent directory, so `](../…)` is a dead link on npm.
      expect(readme).not.toMatch(/]\(\.\.\//)
    })
  }
})

test('the npm package ships the canonical Bunderstack changelog', async () => {
  const [canonical, packaged] = await Promise.all([
    Bun.file(join(repoRoot, 'CHANGELOG.md')).text(),
    Bun.file(join(repoRoot, 'packages/bunderstack/CHANGELOG.md')).text(),
  ])
  expect(packaged).toBe(canonical)
})
