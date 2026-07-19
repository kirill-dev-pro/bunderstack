import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const packages = [
  'bunderstack',
  'bunderstack-query',
  'bunderstack-sync',
  'bunderstack-start',
] as const

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) return []
      if (/\.test\.(ts|tsx)$/.test(entry.name)) return []
      return [path]
    }),
  )
  return nested.flat()
}

describe('published dependency boundaries', () => {
  test('published source has no bundler-ignore escape hatches', async () => {
    for (const name of packages) {
      for (const path of await sourceFiles(
        join(root, 'packages', name, 'src'),
      )) {
        const source = await Bun.file(path).text()
        expect(source, path).not.toContain('@vite-ignore')
        expect(source, path).not.toContain('webpackIgnore')
      }
    }
  })

  test('dynamic imports use string literals', async () => {
    for (const name of packages) {
      for (const path of await sourceFiles(
        join(root, 'packages', name, 'src'),
      )) {
        const source = await Bun.file(path).text()
        const imports = source.matchAll(/\bimport\s*\(([^)]*)\)/gs)
        for (const match of imports) {
          const argument = match[1]!.trim()
          expect(argument, `${path}: import(${argument})`).toMatch(
            /^(?:'[^']+'|"[^"]+")$/s,
          )
        }
      }
    }
  })

  test('lightweight client roots do not import optional integrations', async () => {
    const query = await Bun.file(
      join(root, 'packages/bunderstack-query/src/index.ts'),
    ).text()
    expect(query).not.toMatch(
      /from ['"](?:bunderstack(?:\/|['"])|@trpc\/|superjson)/,
    )

    const start = await Bun.file(
      join(root, 'packages/bunderstack-start/src/index.ts'),
    ).text()
    expect(start).not.toMatch(/from ['"]better-auth/)
    expect(start).not.toContain('export { createStartAuthClient }')
  })
})
