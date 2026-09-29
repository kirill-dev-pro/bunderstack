import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blueprintFromManifest, serializeBlueprint } from './blueprint'
import { bunderstack } from './vite'

async function app(render: 'ssr' | 'spa') {
  const root = await mkdtemp(join(tmpdir(), 'bunderstack-vite-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
  const blueprint = blueprintFromManifest({
    manifest: {
      version: 4,
      database: {
        dialect: 'sqlite',
        migrationsDirectory: './migrations',
        tables: [],
      },
      storage: {
        defaultBucket: 'media',
        buckets: [{ name: 'media', visibility: 'private' }],
      },
      realtime: { required: false },
      messaging: { channels: [] },
      environment: [],
      api: { operations: [] },
      background: { jobs: [], cron: [], maintenance: [] },
    },
    generatorVersion: '1.0.0-beta.4',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    worker: {
      render,
      main:
        render === 'ssr'
          ? 'bunderstack/start/server-entry'
          : 'bunderstack/workers/entry',
      compatibilityDate: '2026-09-28',
      assets: 'dist/client',
    },
  })
  await writeFile(
    join(root, 'bunderstack.blueprint.yaml'),
    serializeBlueprint(blueprint),
  )
  return root
}

const factories = {
  cloudflare: (options: unknown) => ({ name: 'cloudflare', options }),
  tanstackStart: (options: unknown) => ({ name: 'tanstack-start', options }),
}

test('ssr: backend resolver, Cloudflare on the ssr environment, then Start', async () => {
  const root = await app('ssr')
  try {
    const plugins = (await bunderstack({ root, factories })) as {
      name: string
      options?: unknown
      resolveId?: (id: string) => unknown
    }[]
    expect(plugins.map((p) => p.name)).toEqual([
      'bunderstack:backend',
      'cloudflare',
      'tanstack-start',
    ])
    expect(plugins[1]!.options).toEqual({ viteEnvironment: { name: 'ssr' } })
    expect(plugins[0]!.resolveId!('virtual:bunderstack/backend')).toBe(
      join(root, 'src/bunderstack.ts'),
    )
    expect(plugins[0]!.resolveId!('other')).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('spa: no Start plugin; outDirs match the artifact', async () => {
  const root = await app('spa')
  try {
    const plugins = (await bunderstack({ root, factories })) as {
      name: string
      config?: () => unknown
    }[]
    expect(plugins.map((p) => p.name)).toEqual([
      'bunderstack:backend',
      'cloudflare',
    ])
    expect(plugins[0]!.config!()).toEqual({
      build: { outDir: 'dist/client' },
      environments: { ssr: { build: { outDir: 'dist/server' } } },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing blueprint asks to generate it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunderstack-vite-'))
  try {
    await writeFile(join(root, 'package.json'), '{}')
    await expect(bunderstack({ root, factories })).rejects.toThrow(
      /bunderstack blueprint/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
