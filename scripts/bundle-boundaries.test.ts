import { describe, expect, test } from 'bun:test'
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
async function bundle(entrypoint: string, external: string[] = []) {
  const proc = Bun.spawn(['bun', join(repoRoot, 'scripts/bundle-probe.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify({ entrypoint, external })),
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
  expect(result.outputCount).toBe(1)
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
    const output = await bundle('packages/bunderstack-query/src/index.ts', [
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
      'packages/bunderstack/src',
    ])
    expect(output.text).toContain('@orpc/client')
    expect(output.text).toContain('@orpc/tanstack-query')
    expect(output.text).not.toContain('@orpc/server')
    expect(output.text).not.toContain('@orpc/openapi')
    expect(output.text).not.toContain('@orpc/valibot')
  })

  test('start root keeps TanStack server external and excludes auth', async () => {
    const output = await bundle('packages/bunderstack-start/src/index.ts', [
      '@tanstack/react-start/server',
      '@tanstack/react-query',
      'bunderstack-sync',
    ])
    expect(output.size).toBeLessThan(32 * 1024)
    expectNoBundleInputs(output.inputs, [
      '/better-auth/',
      'packages/bunderstack-start/src/auth-client.',
    ])
    expect(output.text).not.toContain('better-auth')
  })

  test('the live view client stays browser-only and dependency-free', async () => {
    const output = await bundle('packages/bunderstack/src/live/index.ts')
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
