import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlueprintCheckError, generateBlueprint } from './blueprint-generator'

const bunderstackEntry = join(import.meta.dir, 'index.ts')

async function fixture(
  entry = 'src/bunderstack.ts',
  migrationsDirectory = './migrations',
) {
  const tempRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(tempRoot, 'bunderstack-blueprint-'))
  const entryPath = join(directory, entry)
  await mkdir(join(entryPath, '..'), { recursive: true })
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      scripts: {
        build: 'vite build',
        start: 'bun .output/server/index.mjs',
        worker: 'bun src/worker.ts',
      },
      dependencies: { '@tanstack/react-start': '^1.0.0' },
      ...(entry === 'src/bunderstack.ts' ? {} : { bunderstack: { entry } }),
    }),
  )
  await Bun.write(
    entryPath,
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}

const throwingAdapter = {
  dialect: 'sqlite',
  driver: 'libsql',
  async connect() { throw new Error('blueprint must not boot the runtime') },
  async migrate() {},
}

export const backend = bunderstack({
  schema: {},
  database: { adapter: throwingAdapter, migrations: ${JSON.stringify(migrationsDirectory)} },
  jobs: (j) => j.define({
    nightly: j.cron({ schedule: '0 3 * * *', handler() {} }),
  }),
})`,
  )
  return directory
}

test('generateBlueprint discovers package entry and supports freshness checks', async () => {
  const directory = await fixture('src/bunderstack/index.ts')
  const callerEnvKey = ['BUNDERSTACK', 'INTROSPECT'].join('_')
  const previous = process.env[callerEnvKey]
  process.env[callerEnvKey] = 'caller-owned'
  try {
    const result = await generateBlueprint({ directory })
    expect(result.changed).toBe(true)
    expect(result.blueprint.bunderstack.entry).toBe('src/bunderstack/index.ts')
    expect(result.blueprint.background.cron).toContainEqual(
      expect.objectContaining({ name: 'nightly' }),
    )
    expect(process.env[callerEnvKey]).toBe('caller-owned')
    await expect(
      generateBlueprint({ directory, check: true }),
    ).resolves.toMatchObject({ changed: false })
    await Bun.write(join(directory, 'bunderstack.blueprint.yaml'), 'stale\n')
    await expect(
      generateBlueprint({ directory, check: true }),
    ).rejects.toBeInstanceOf(BlueprintCheckError)
  } finally {
    if (previous === undefined) delete process.env[callerEnvKey]
    else process.env[callerEnvKey] = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint normalizes absolute migration directories inside the application', async () => {
  const directory = await fixture()
  const migrationsDirectory = join(directory, 'migrations')
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}
export const backend = bunderstack({
  schema: {},
  database: {
    adapter: { dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} },
    migrations: ${JSON.stringify(migrationsDirectory)},
  },
})`,
  )
  try {
    const result = await generateBlueprint({ directory })
    expect(result.blueprint.resources.database.migrationsDirectory).toBe(
      'migrations',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint detects solid framework from dependencies', async () => {
  const tempRoot = await realpath(tmpdir())
  const directory = await mkdtemp(
    join(tempRoot, 'bunderstack-blueprint-solid-'),
  )
  const entryPath = join(directory, 'src/bunderstack.ts')
  await mkdir(join(entryPath, '..'), { recursive: true })
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      scripts: { build: 'vite build', start: 'bun src/server.ts' },
      dependencies: {
        'solid-js': '^2.0.0-rc.1',
        '@solidjs/web': '^2.0.0-rc.1',
        bunderstack: '^1.0.0',
      },
    }),
  )
  await Bun.write(
    entryPath,
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}
export const backend = bunderstack({
  schema: {},
  database: { adapter: { dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} } },
})`,
  )
  try {
    const result = await generateBlueprint({ directory })
    expect(result.blueprint.application.framework).toBe('solid')
    expect(result.source).toContain('framework: solid')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint rejects unbranded manifest lookalikes', async () => {
  const directory = await fixture()
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `export const backend = { manifest: {} }`,
  )
  try {
    await expect(generateBlueprint({ directory })).rejects.toThrow(
      /must export backend/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint accepts env values that only change runtime configuration', async () => {
  const directory = await fixture()
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}
const flag = { '~standard': { version: 1, vendor: 'test', validate(value) {
  return value === 'true' || value === 'false'
    ? { value }
    : { issues: [{ message: 'expected flag' }] }
} } }
export const backend = bunderstack({
  schema: {},
  env: { server: { FEATURE: flag } },
  database: (env) => ({
    adapter: { dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} },
    url: env.FEATURE,
  }),
})`,
  )
  try {
    await expect(generateBlueprint({ directory })).resolves.toBeDefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint rejects environment-dependent declaration shape without leaking values', async () => {
  const directory = await fixture()
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}
const flag = { '~standard': { version: 1, vendor: 'test', validate(value) {
  return value === 'true' || value === 'false'
    ? { value }
    : { issues: [{ message: 'expected flag' }] }
} } }
export const backend = bunderstack({
  schema: {},
  env: { server: { FEATURE: flag } },
  database: { adapter: { dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} } },
  realtime: (env) => env.FEATURE === 'true',
})`,
  )
  try {
    await expect(generateBlueprint({ directory })).rejects.toThrow(
      /realtime\.required/,
    )
    await expect(generateBlueprint({ directory })).rejects.not.toThrow(
      /true|false/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint emits a version 2 blueprint and never serializes secret values', async () => {
  const tempRoot = await realpath(tmpdir())
  const directory = await mkdtemp(
    join(tempRoot, 'bunderstack-blueprint-worker-'),
  )
  const entryPath = join(directory, 'src/bunderstack.ts')
  await mkdir(join(entryPath, '..'), { recursive: true })
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      scripts: { build: 'bunderstack build' },
      dependencies: { bunderstack: '^1.0.0-beta.2' },
    }),
  )
  await Bun.write(
    entryPath,
    `import { bunderstack } from ${JSON.stringify(bunderstackEntry)}
const secret = { '~standard': { version: 1, vendor: 'test', validate(value) {
  return typeof value === 'string' && value.length > 0
    ? { value }
    : { issues: [{ message: 'expected secret' }] }
} } }
export const backend = bunderstack({
  schema: {},
  env: {
    server: { OPENAI_API_KEY: secret },
    meta: { OPENAI_API_KEY: { description: 'Provider key' } },
  },
  database: { adapter: { dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} } },
  jobs: (j) => j.define({
    agentTurn: j.job({ handler() {} }),
  }),
})`,
  )
  const previousSecret = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-super-secret-live-value'
  try {
    const result = await generateBlueprint({ directory })
    expect(result.blueprint.version).toBe(2)
    expect(result.blueprint.application).toMatchObject({
      framework: 'bun-ssr',
      scripts: { build: 'build' },
    })
    expect('worker' in result.blueprint.background).toBe(false)
    expect(result.blueprint.environment).toEqual([
      {
        key: 'OPENAI_API_KEY',
        required: true,
        scope: 'server',
        sensitive: true,
        description: 'Provider key',
      },
    ])
    expect(result.source).not.toContain('sk-super-secret-live-value')
    await expect(
      generateBlueprint({ directory, check: true }),
    ).resolves.toMatchObject({ changed: false })
  } finally {
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousSecret
    await rm(directory, { recursive: true, force: true })
  }
})
