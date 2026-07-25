import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
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
  test('canonical docs show an explicit database adapter', async () => {
    for (const path of [
      'README.md',
      'packages/bunderstack/README.md',
      'website/content/docs/getting-started.mdx',
      'website/content/docs/configuration.mdx',
      'website/content/docs/email.mdx',
    ]) {
      const source = await Bun.file(join(repoRoot, path)).text()
      expect(source, path).toContain('adapter: libsql()')
      expect(source, path).toContain('bunderstack/database/libsql')
    }
  })

  test('configuration and email docs use the SMTP factory', async () => {
    for (const path of [
      'website/content/docs/configuration.mdx',
      'website/content/docs/email.mdx',
    ]) {
      const source = await Bun.file(join(repoRoot, path)).text()

      expect(source, path).toContain('bunderstack/email/smtp')
      expect(source, path).toContain('provider: smtp(')
      expect(source, path).not.toContain("email: 'smtp'")
      expect(source, path).not.toContain("provider: 'smtp'")
    }
  })

  test('published source has no bundler-ignore escape hatches', async () => {
    for (const name of packages) {
      for (const path of await sourceFiles(
        join(repoRoot, 'packages', name, 'src'),
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
        join(repoRoot, 'packages', name, 'src'),
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
      join(repoRoot, 'packages/bunderstack-query/src/index.ts'),
    ).text()
    expect(query).not.toMatch(
      /from ['"](?:bunderstack(?:\/|['"])|@trpc\/|superjson)/,
    )

    const start = await Bun.file(
      join(repoRoot, 'packages/bunderstack-start/src/index.ts'),
    ).text()
    expect(start).not.toMatch(/from ['"]better-auth/)
    expect(start).not.toContain('export { createStartAuthClient }')
  })

  test('query client keeps QueryClient type-only', async () => {
    const source = await Bun.file(
      join(repoRoot, 'packages/bunderstack-query/src/client.ts'),
    ).text()

    expect(source).toContain(
      "import type { QueryClient } from '@tanstack/react-query'",
    )
    expect(source).not.toMatch(
      /import\s+\{\s*QueryClient\s*\}\s+from\s+['"]@tanstack\/react-query['"]/,
    )
  })

  test('manifests declare correct peers and dependencies', async () => {
    for (const name of packages) {
      const manifestPath = join(repoRoot, 'packages', name, 'package.json')
      const manifest = await Bun.file(manifestPath).json()
      expect(manifest.peerDependencies?.typescript).toBe('>=5')
      expect(manifest.peerDependenciesMeta?.typescript?.optional).toBe(true)
    }

    const core = await Bun.file(
      join(repoRoot, 'packages/bunderstack/package.json'),
    ).json()
    expect(core.peerDependencies['@trpc/server']).toBeDefined()
    expect(core.peerDependencies['better-auth']).toBeDefined()
    expect(core.peerDependencies['drizzle-orm']).toBeDefined()
    expect(core.peerDependencies['hono']).toBeDefined()
    expect(core.peerDependencies['zod']).toBeDefined()

    expect(core.peerDependencies['@electric-sql/pglite']).toBeDefined()
    expect(core.peerDependencies['@libsql/client']).toBeDefined()
    expect(core.peerDependencies['drizzle-kit']).toBeDefined()
    expect(core.peerDependencies['nodemailer']).toBe('>=6 <10')
    expect(core.peerDependencies['postgres']).toBeDefined()

    expect(Object.keys(core.dependencies)).toEqual(['superjson'])

    const rootManifest = await Bun.file(join(repoRoot, 'package.json')).json()
    expect(rootManifest.devDependencies.nodemailer).toBe('^9.0.3')

    const query = await Bun.file(
      join(repoRoot, 'packages/bunderstack-query/package.json'),
    ).json()
    expect(query.peerDependencies['@tanstack/react-query']).toBeDefined()
    expect(query.peerDependencies['@trpc/client']).toBeDefined()
    expect(query.peerDependencies['@trpc/server']).toBeDefined()
    expect(query.peerDependencies['@trpc/tanstack-react-query']).toBeDefined()
    expect(query.peerDependencies['bunderstack']).toBeDefined()
    expect(query.peerDependencies['superjson']).toBeDefined()
    expect(query.dependencies).toBeUndefined()

    const sync = await Bun.file(
      join(repoRoot, 'packages/bunderstack-sync/package.json'),
    ).json()
    expect(Object.keys(sync.dependencies)).toEqual(['bunderstack-query'])
    expect(sync.peerDependencies['@tanstack/react-query']).toBeDefined()

    const start = await Bun.file(
      join(repoRoot, 'packages/bunderstack-start/package.json'),
    ).json()
    expect(Object.keys(start.dependencies)).toEqual(['bunderstack-sync'])
    expect(start.peerDependencies['@tanstack/react-query']).toBeDefined()
    expect(start.peerDependencies['@tanstack/react-start']).toBeDefined()
    expect(start.peerDependencies['better-auth']).toBeDefined()
    expect(start.peerDependenciesMeta['better-auth']?.optional).toBe(true)
  })

  test('bunderstack peer metadata matches runtime import boundaries', async () => {
    const pkg = await Bun.file(
      join(repoRoot, 'packages/bunderstack/package.json'),
    ).json()

    expect(pkg.peerDependencies['better-auth']).toBe('^1.0.0')
    expect(pkg.peerDependenciesMeta?.['better-auth']).toBeUndefined()
    expect(pkg.peerDependencies.nodemailer).toBe('>=6 <10')
    expect(pkg.peerDependenciesMeta.nodemailer.optional).toBe(true)
    expect(pkg.peerDependencies.typescript).toBe('>=5')
    expect(pkg.peerDependenciesMeta.typescript.optional).toBe(true)
  })

  test('published package source does not disable TypeScript checking', async () => {
    const glob = new Bun.Glob('packages/*/src/**/*.{ts,tsx}')
    const offenders: string[] = []

    for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      const source = await Bun.file(join(repoRoot, path)).text()
      if (source.includes('@ts-nocheck')) offenders.push(path)
    }

    expect(offenders).toEqual([])
  })
})
