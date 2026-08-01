import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { BlueprintCheckError, generateBlueprint } from './blueprint-generator'

const tempRoot = '/private/tmp'

async function fixture(entry = 'src/bunderstack.ts', migrationsDirectory = './migrations') {
  const directory = await mkdtemp(join(tempRoot, 'bunderstack-blueprint-'))
  const entryPath = join(directory, entry)
  await mkdir(join(entryPath, '..'), { recursive: true })
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      scripts: { build: 'vite build', start: 'bun .output/server/index.mjs' },
      dependencies: { '@tanstack/react-start': '^1.0.0' },
      ...(entry === 'src/bunderstack.ts' ? {} : { bunderstack: { entry } }),
    }),
  )
  await Bun.write(
    entryPath,
    `export const app = { manifest: ${JSON.stringify({
      version: 3,
      database: { dialect: 'sqlite', migrationsDirectory, tables: [] },
      storage: { defaultBucket: 'default', buckets: [{ name: 'default', visibility: 'private' }] },
      realtime: { required: false },
      environment: [],
      background: { jobs: [], cron: [], maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' }] },
    })}, close: async () => {} }`,
  )
  return directory
}

test('generateBlueprint discovers package entry and supports freshness checks', async () => {
  const directory = await fixture('src/bunderstack/index.ts')
  try {
    const result = await generateBlueprint({ directory })
    expect(result.changed).toBe(true)
    expect(result.blueprint.bunderstack.entry).toBe('src/bunderstack/index.ts')
    await expect(generateBlueprint({ directory, check: true })).resolves.toMatchObject({ changed: false })
    await Bun.write(join(directory, 'bunderstack.blueprint.yaml'), 'stale\n')
    await expect(generateBlueprint({ directory, check: true })).rejects.toBeInstanceOf(BlueprintCheckError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint normalizes absolute migration directories inside the application', async () => {
  const directory = await fixture()
  const migrationsDirectory = join(directory, 'migrations')
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `export const app = { manifest: ${JSON.stringify({
      version: 3,
      database: { dialect: 'sqlite', migrationsDirectory, tables: [] },
      storage: { defaultBucket: 'default', buckets: [{ name: 'default', visibility: 'private' }] },
      realtime: { required: false },
      environment: [],
      background: { jobs: [], cron: [], maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' }] },
    })}, close: async () => {} }`,
  )
  try {
    const result = await generateBlueprint({ directory })
    expect(result.blueprint.resources.database.migrationsDirectory).toBe('migrations')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
