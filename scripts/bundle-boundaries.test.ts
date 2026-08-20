import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

async function bundle(entrypoint: string, external: string[] = []) {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, entrypoint)],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: true,
    sourcemap: 'none',
    metafile: true,
    external,
    write: false,
  })
  expect(result.success, result.logs.map(String).join('\n')).toBe(true)
  expect(result.outputs).toHaveLength(1)
  const output = result.outputs[0]!
  return {
    text: await output.text(),
    size: output.size,
    metafile: result.metafile!,
    inputs: Object.keys(result.metafile!.inputs),
  }
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
})
