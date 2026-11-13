import { expect, test } from 'bun:test'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateBlueprint } from './blueprint-generator'
import { runCli } from './cli'
import { seedCommand } from './seed-command'

const source = (file: string) => JSON.stringify(join(import.meta.dir, file))

/**
 * An application directory whose backend declares a seed. `seed` is the body
 * of the seed function; `adapter` and `url` choose its database.
 */
async function application(
  options: { seed?: string | null; adapter?: string; url?: string } = {},
) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'bunderstack-seed-'),
  )
  const body =
    options.seed === undefined
      ? `await db.insert(schema.notes).values([{ id: 'first' }, { id: 'second' }])`
      : options.seed
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      scripts: { build: 'vite build', start: 'bun server.js' },
      dependencies: { '@tanstack/react-start': '^1.0.0' },
    }),
  )
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `import { sqliteTable, text } from ${JSON.stringify(Bun.resolveSync('drizzle-orm/sqlite-core', import.meta.dir))}
import { bunderstack } from ${source('index.ts')}
import { libsql } from ${source('database/libsql.ts')}
import { defineSeed } from ${source('seed.ts')}

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const adapter = ${options.adapter ?? 'libsql()'}

export const backend = bunderstack({
  schema: { notes },
  database: {
    adapter,
    url: ${JSON.stringify(options.url ?? 'file:./data.db')},
    ${body === null ? '' : 'seed: async () => ({ default: seed }),'}
  },
})
const seed = defineSeed(backend, async ({ db, schema }) => {
  ${body ?? ''}
})
`,
  )
  return {
    directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('generating a blueprint runs the seed against a throwaway database', async () => {
  await using app = await application()
  const result = await generateBlueprint({ directory: app.directory })

  expect(result.seedCheck).toEqual({ status: 'passed' })
  expect(result.blueprint.resources.database.seed).toBe(true)
  expect(result.source).toContain('\n    seed: true\n')
  // The application's own database was never opened, let alone seeded.
  expect((await readdir(app.directory)).sort()).toEqual([
    'bunderstack.blueprint.yaml',
    'package.json',
    'src',
  ])
})

test('a seed that does not fit the schema stops the blueprint, and its check', async () => {
  await using app = await application()
  const current = await generateBlueprint({ directory: app.directory })

  // Another commit of the same application: the seed changed, the
  // declaration did not, so its committed blueprint is still current.
  await using broken = await application({
    seed: `await db.insert(schema.notes).values([{ id: 'same' }, { id: 'same' }])`,
  })
  await Bun.write(
    join(broken.directory, 'bunderstack.blueprint.yaml'),
    current.source,
  )
  for (const check of [true, false]) {
    const failure = await generateBlueprint({
      directory: broken.directory,
      check,
    }).catch((error) => error)
    expect(failure.message).toStartWith(
      '[bunderstack] the seed does not run against this schema.\n',
    )
    expect(failure.message).toContain('nothing it wrote was kept')
    expect(failure.message).toContain('UNIQUE constraint failed: notes.id')
  }
})

test('an application without a seed is not started to generate its blueprint', async () => {
  await using app = await application({
    seed: null,
    adapter: `{ dialect: 'sqlite', driver: 'libsql', async connect() { throw new Error('must not connect') }, async migrate() {} }`,
  })
  const result = await generateBlueprint({ directory: app.directory })
  expect(result.seedCheck).toBeUndefined()
  expect(result.blueprint.resources.database.seed).toBeUndefined()
  expect(result.source).not.toContain('seed: true')
})

test('a seed is not checked where there is no throwaway database for it', async () => {
  await using app = await application({
    // A driver that needs a server somewhere has no testing strategy.
    adapter: `{ ...libsql(), driver: 'postgres-js', testing: undefined }`,
  })
  const result = await generateBlueprint({ directory: app.directory })
  expect(result.seedCheck).toEqual({
    status: 'skipped',
    reason:
      'the postgres-js adapter has no throwaway database to run it against',
  })
  expect(result.blueprint.resources.database.seed).toBe(true)
})

test('the seed command fills a local database once and again after a reset', async () => {
  await using app = await application()
  const requested = process.env.BUNDERSTACK_SEED
  // Even when the variable is in the environment, the command seeds once.
  process.env.BUNDERSTACK_SEED = '1'
  try {
    expect(await seedCommand({ directory: app.directory })).toEqual({
      outcome: 'seeded',
    })
    expect(await seedCommand({ directory: app.directory })).toEqual({
      outcome: 'already-seeded',
    })
    expect(
      await seedCommand({ directory: app.directory, reset: true }),
    ).toEqual({ outcome: 'seeded', emptied: ['notes'] })
  } finally {
    if (requested === undefined) delete process.env.BUNDERSTACK_SEED
    else process.env.BUNDERSTACK_SEED = requested
  }
  const { Database } = await import('bun:sqlite')
  const database = new Database(join(app.directory, 'data.db'))
  expect(database.query('SELECT id FROM notes ORDER BY id').all()).toEqual([
    { id: 'first' },
    { id: 'second' },
  ])
  database.close()
})

test('the seed command refuses a remote database and says when there is no seed', async () => {
  await using remote = await application({
    url: 'libsql://shop.example.turso.io',
  })
  await expect(seedCommand({ directory: remote.directory })).rejects.toThrow(
    'runs against a local database, and this one is remote',
  )
  await using plain = await application({ seed: null })
  expect(await seedCommand({ directory: plain.directory })).toEqual({
    outcome: 'not-declared',
  })
})

test('seed CLI reports what happened and rejects invalid syntax', async () => {
  const run = async (
    args: string[],
    result: Awaited<ReturnType<typeof seedCommand>>,
  ) => {
    const output: string[] = []
    const errors: string[] = []
    const calls: unknown[] = []
    const code = await runCli(
      args,
      {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
      undefined,
      async (options) => {
        calls.push(options)
        return result
      },
    )
    return { code, output, errors, calls }
  }

  const seeded = await run(['seed', 'apps/shop', '--entry', 'src/app.ts'], {
    outcome: 'seeded',
  })
  expect(seeded).toMatchObject({
    code: 0,
    output: ['Seeded the database'],
    calls: [{ directory: 'apps/shop', entry: 'src/app.ts' }],
  })

  const reset = await run(['seed', '--reset'], {
    outcome: 'seeded',
    emptied: ['orders', 'users'],
  })
  expect(reset.calls).toEqual([{ directory: process.cwd(), reset: true }])
  expect(reset.output).toEqual([
    'Emptied 2 table(s): orders, users',
    'Seeded the database',
  ])

  const again = await run(['seed'], { outcome: 'already-seeded' })
  expect(again.code).toBe(0)
  expect(again.output[0]).toContain('already seeded')

  const none = await run(['seed'], { outcome: 'not-declared' })
  expect(none.code).toBe(1)
  expect(none.errors[0]).toContain('declares no seed')

  expect((await run(['seed', '--force'], { outcome: 'seeded' })).code).toBe(2)
  expect((await run(['seed', '--entry'], { outcome: 'seeded' })).code).toBe(2)
  expect((await run(['seed', 'a', 'b'], { outcome: 'seeded' })).code).toBe(2)
})
