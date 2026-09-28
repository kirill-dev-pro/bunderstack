import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devSecret, devVars, parseDotenv, readUserEnv } from './env'

const dirs: string[] = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-env-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

test('parseDotenv reads plain, exported, quoted, and commented lines', () => {
  expect(
    parseDotenv(
      [
        '# comment',
        '',
        'A=1',
        'export B=two words # trailing',
        "C='single # kept'",
        'D="line\\nbreak"',
        'E=',
        'not a pair',
      ].join('\n'),
    ),
  ).toEqual({
    A: '1',
    B: 'two words',
    C: 'single # kept',
    D: 'line\nbreak',
    E: '',
  })
})

test('readUserEnv lets .env.local override .env', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, '.env'), 'A=1\nB=1\n')
  await writeFile(join(dir, '.env.local'), 'B=2\n')
  expect(await readUserEnv(dir)).toEqual({ A: '1', B: '2' })
  expect(await readUserEnv(await tempDir())).toEqual({})
})

test('devSecret is created once and then reused', async () => {
  const dir = join(await tempDir(), 'state')
  const first = await devSecret(dir)
  expect(first.length).toBeGreaterThanOrEqual(32)
  expect(await devSecret(dir)).toBe(first)
})

test('devVars owns the database and app URLs and keeps a user secret', () => {
  const text = devVars({
    userEnv: {
      APP_URL: 'http://localhost:3007',
      BUNDERSTACK_DATABASE_URL: 'file:./old.db',
      AUTH_SECRET: 'mine',
      NOTE: 'has "quotes" and # hash',
    },
    databaseUrl: 'http://127.0.0.1:9000',
    appUrl: 'http://localhost:5173',
    authSecret: 'generated',
  })
  expect(parseDotenv(text)).toEqual({
    APP_URL: 'http://localhost:5173',
    BUNDERSTACK_DATABASE_URL: 'http://127.0.0.1:9000',
    AUTH_SECRET: 'mine',
    NOTE: 'has "quotes" and # hash',
  })
})

test('devVars uses the dev secret when the user has none', () => {
  const vars = parseDotenv(
    devVars({
      userEnv: {},
      databaseUrl: 'http://db',
      appUrl: 'http://app',
      authSecret: 'generated',
    }),
  )
  expect(vars.AUTH_SECRET).toBe('generated')
})
