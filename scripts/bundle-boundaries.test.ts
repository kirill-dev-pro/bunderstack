import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

type ProbeResult = {
  success: boolean
  logs: string
  outputCount: number
  text: string
  size: number
  inputs: string[]
}

// Bun.build() must not run in this process: it breaks bare-specifier
// resolution for every later-loaded file in the built file's own package,
// which is what made `bun test` at the repo root fail to import
// '@tanstack/query-core' & co. from bunderstack-query. See scripts/bundle-probe.ts.
async function bundle(
  entrypoint: string,
  external: string[] = [],
  target: 'browser' | 'bun' = 'browser',
  splitting = false,
) {
  const proc = Bun.spawn(['bun', join(repoRoot, 'scripts/bundle-probe.ts')], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ entrypoint, external, target, splitting }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode, stderr).toBe(0)

  const result = JSON.parse(stdout) as ProbeResult
  expect(result.success, result.logs).toBe(true)
  if (splitting) expect(result.outputCount).toBeGreaterThan(1)
  else expect(result.outputCount).toBe(1)
  return result
}

function expectNoBundleInputs(inputs: string[], forbidden: string[]) {
  for (const path of forbidden) {
    expect(
      inputs.some((input) => input.includes(path)),
      path,
    ).toBe(false)
  }
}

describe('browser bundle boundaries', () => {
  test('unified query root stays browser-only', async () => {
    const output = await bundle('packages/bunderstack/src/query/index.ts', [
      '@orpc/client',
      '@orpc/client/fetch',
      '@orpc/tanstack-query',
      '@standardserver/core',
      '@tanstack/query-core',
    ])
    expect(output.size).toBeLessThan(32 * 1024)
    expectNoBundleInputs(output.inputs, [
      '/@tanstack/react-query/',
      '/better-auth/',
      '/drizzle-orm/',
      'packages/bunderstack/src/index.ts',
      'packages/bunderstack/src/database',
    ])
    expect(output.text).toContain('@orpc/client')
    expect(output.text).toContain('@orpc/tanstack-query')
    expect(output.text).not.toContain('@orpc/server')
    expect(output.text).not.toContain('@orpc/openapi')
    expect(output.text).not.toContain('@orpc/valibot')
  })

  test('start root keeps TanStack server external and excludes auth', async () => {
    const output = await bundle('packages/bunderstack/src/start/index.ts', [
      '@orpc/client',
      '@orpc/client/fetch',
      '@orpc/tanstack-query',
      '@standardserver/core',
      '@tanstack/db',
      '@tanstack/query-core',
      '@tanstack/query-db-collection',
      '@tanstack/react-query',
      '@tanstack/react-start/server',
    ])
    expect(output.size).toBeLessThan(32 * 1024)
    expectNoBundleInputs(output.inputs, [
      '/better-auth/',
      'packages/bunderstack/src/start/auth-client.',
      'packages/bunderstack/src/index.ts',
      'packages/bunderstack/src/database',
    ])
    expect(output.text).not.toContain('better-auth')
  })

  test('the live view client stays browser-only and dependency-free', async () => {
    const output = await bundle('packages/bunderstack/src/client/live-view.ts')
    expect(output.size).toBeLessThan(8 * 1024)
    expectNoBundleInputs(output.inputs, [
      '/drizzle-orm/',
      '/better-auth/',
      '/valibot/',
      'packages/bunderstack/src/api',
      'packages/bunderstack/src/index.ts',
    ])
    expect(output.text).not.toContain('@orpc/')
  })
})

describe('server bundle boundaries', () => {
  const serverExternal = [
    '@electric-sql/pglite',
    '@libsql/client',
    '@orpc/*',
    '@standard-schema/spec',
    '@standardserver/core',
    'better-auth',
    'better-auth/*',
    'drizzle-kit',
    'drizzle-orm',
    'drizzle-orm/*',
    'nodemailer',
    'postgres',
    'valibot',
    'yaml',
  ]

  test('production provision entry has no drizzle-kit import edge', async () => {
    const output = await bundle(
      'packages/bunderstack/src/provision.ts',
      serverExternal,
      'bun',
    )
    expectNoBundleInputs(output.inputs, ['/drizzle-kit/'])
    expect(output.text).not.toContain('drizzle-kit/api')
  })

  test('Vite SSR bundles production provision without Drizzle Kit', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'bunderstack-vite-provision-'))
    const outDir = join(fixture, 'dist')
    const configPath = join(fixture, 'vite.config.ts')
    const entrypoint = join(repoRoot, 'packages/bunderstack/src/provision.ts')

    await writeFile(
      configPath,
      `export default {
  logLevel: 'silent',
  build: {
    ssr: ${JSON.stringify(entrypoint)},
    outDir: ${JSON.stringify(outDir)},
    emptyOutDir: true,
    minify: false,
  },
  ssr: { noExternal: true },
}
`,
    )

    try {
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          '--cwd',
          join(repoRoot, 'examples/todo'),
          'vite',
          'build',
          '--config',
          configPath,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exitCode, stdout + stderr).toBe(0)

      const chunks = await readdir(outDir)
      const output = (
        await Promise.all(
          chunks
            .filter((name) => name.endsWith('.js'))
            .map((name) => readFile(join(outDir, name), 'utf8')),
        )
      ).join('\n')
      expect(output).not.toContain('drizzle-kit/api')
      expect(output).not.toContain('aws-data-api')
      expect(output).not.toContain('vercel-postgres')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  test('root runtime does not eagerly bundle test fixtures', async () => {
    const output = await bundle(
      'packages/bunderstack/src/index.ts',
      serverExternal,
      'bun',
      true,
    )
    expect(output.text).not.toContain('bunderstack-storage-')
    expect(output.text).not.toContain('node:fs')
    expect(output.text).not.toContain('node:os')
    expect(output.text).not.toContain('bun:test')
  })

  test('testing entry includes fixtures without importing bun:test', async () => {
    const output = await bundle(
      'packages/bunderstack/src/testing.ts',
      serverExternal,
      'bun',
    )
    expect(
      output.inputs.some((input) =>
        input.includes('packages/bunderstack/src/testing/fixture.'),
      ),
    ).toBe(true)
    expect(output.text).not.toContain('bun:test')
  })
})
