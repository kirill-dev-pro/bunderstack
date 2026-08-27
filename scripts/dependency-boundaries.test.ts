import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const packages = ['bunderstack'] as const

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
  test('runtime sources and manifests contain no legacy transport stack', async () => {
    const forbidden = [
      /from ['"]hono(?:\/|['"])/,
      /@trpc\//,
      /from ['"]zod['"]/,
      /drizzle-zod/,
      /@orpc\/zod/,
      /createRealtimeClient/,
      /createBunderstackQueryClient/,
    ]

    for (const name of packages) {
      for (const path of await sourceFiles(
        join(repoRoot, 'packages', name, 'src'),
      )) {
        const source = await Bun.file(path).text()
        for (const pattern of forbidden)
          expect(source, path).not.toMatch(pattern)
      }

      const manifestPath = join(repoRoot, 'packages', name, 'package.json')
      const manifest = await Bun.file(manifestPath).text()
      for (const pattern of forbidden)
        expect(manifest, manifestPath).not.toMatch(pattern)
    }
  })

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
        if (path.endsWith('/blueprint-generator.ts')) continue
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
        if (path.endsWith('/blueprint-generator.ts')) continue
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

  test('client roots do not import server implementations or optional auth', async () => {
    const query = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/query/index.ts'),
    ).text()
    expect(query).not.toMatch(/from ['"](?:bunderstack(?:\/|['"])|better-auth)/)
    expect(query).not.toMatch(/from ['"]\.\.\/index/)

    const start = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/start/index.ts'),
    ).text()
    expect(start).not.toMatch(/from ['"]better-auth/)
    expect(start).not.toContain('export { createStartAuthClient }')
  })

  test('testing is an explicit subpath instead of a root wildcard', async () => {
    const testing = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/testing.ts'),
    ).text()
    const root = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/index.ts'),
    ).text()
    const runtime = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/runtime.ts'),
    ).text()

    expect(testing).not.toMatch(
      /export \* from ['"]\.\/(?:backend|runtime)['"]/,
    )
    expect(root).not.toMatch(/export .* from ['"]\.\/testing['"]/)
    expect(runtime).not.toMatch(/from ['"]\.\/testing(?:['"/])/)
  })

  test('query client keeps QueryClient type-only and framework-neutral', async () => {
    const source = await Bun.file(
      join(repoRoot, 'packages/bunderstack/src/query/client.ts'),
    ).text()

    expect(source).toContain(
      "import type { QueryClient } from '@tanstack/query-core'",
    )
    expect(source).not.toMatch(
      /import\s+\{\s*QueryClient\s*\}\s+from\s+['"]@tanstack\/query-core['"]/,
    )
    // The client is consumed from Solid and React alike — see
    // examples/todo-solid-2, which installs no React packages at all.
    expect(source).not.toMatch(/@tanstack\/react-query/)
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
    expect(core.peerDependencies['better-auth']).toBe('^1.0.0')
    expect(core.peerDependencies['drizzle-orm']).toBeDefined()
    expect(core.peerDependencies['@orpc/server']).toBe('2.0.0-beta.26')
    expect(core.peerDependencies['@orpc/client']).toBe('2.0.0-beta.26')
    expect(core.peerDependencies['@orpc/publisher']).toBe('2.0.0-beta.26')
    expect(core.peerDependencies['@orpc/bun']).toBe('2.0.0-beta.26')
    expect(core.peerDependencies['@orpc/valibot']).toBe('2.0.0-beta.26')
    expect(core.peerDependencies['drizzle-valibot']).toBeDefined()

    expect(core.peerDependencies['@electric-sql/pglite']).toBeDefined()
    expect(core.peerDependencies['@libsql/client']).toBeDefined()
    expect(core.peerDependencies['drizzle-kit']).toBeDefined()
    expect(core.peerDependencies['nodemailer']).toBe('>=6 <10')
    expect(core.peerDependencies['postgres']).toBeDefined()

    expect(Object.keys(core.dependencies).sort()).toEqual([
      '@orpc/client',
      '@orpc/server',
      '@standard-schema/spec',
      '@standardserver/core',
      'valibot',
      'yaml',
    ])

    const rootManifest = await Bun.file(join(repoRoot, 'package.json')).json()
    expect(rootManifest.devDependencies.nodemailer).toBe('^9.0.3')
  })

  test('bunderstack peer metadata matches runtime import boundaries', async () => {
    const pkg = await Bun.file(
      join(repoRoot, 'packages/bunderstack/package.json'),
    ).json()

    expect(pkg.peerDependencies['better-auth']).toBe('^1.0.0')
    expect(pkg.peerDependenciesMeta?.['better-auth']?.optional).toBe(true)
    expect(pkg.peerDependencies.nodemailer).toBe('>=6 <10')
    expect(pkg.peerDependenciesMeta.nodemailer.optional).toBe(true)
    expect(pkg.peerDependencies.typescript).toBe('>=5')
    expect(pkg.peerDependenciesMeta.typescript.optional).toBe(true)

    for (const dependency of [
      '@orpc/openapi',
      '@orpc/server',
      '@orpc/bun',
      '@orpc/publisher',
      '@orpc/valibot',
      'drizzle-valibot',
    ]) {
      expect(pkg.peerDependencies[dependency]).toBeDefined()
      expect(pkg.peerDependenciesMeta?.[dependency]).toBeUndefined()
    }
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
