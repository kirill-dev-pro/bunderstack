import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateBlueprint } from '../blueprint-generator'
import { celldLine, firstFreePort, planDev, runBuild } from './index'

test('firstFreePort skips a port that is taken on 127.0.0.1', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const taken = (server.address() as { port: number }).port
  try {
    expect(await firstFreePort(taken)).toBeGreaterThan(taken)
  } finally {
    server.close()
  }
})

test('celldLine keeps Worker output, warnings, and the summary', () => {
  expect(
    celldLine(
      '2026-09-28T07:44:09.959728Z  INFO cell_console: {"event":"job.claimed"}',
    ),
  ).toBe('{"event":"job.claimed"}')
  expect(
    celldLine('2026-09-28T07:44:09.4Z  WARN celld::runtime: slow cell'),
  ).toBe('WARN slow cell')
  expect(
    celldLine('2026-09-28T07:44:09.4Z  INFO celld::ltx_repl: barrier passed'),
  ).toBeUndefined()
  expect(
    celldLine(
      '2026-09-28T07:44:09.4Z  WARN celld::memory: no background thread',
    ),
  ).toBeUndefined()
  expect(celldLine('<jemalloc>: option background_thread')).toBeUndefined()
  expect(celldLine('env.SCHEDULER (Scheduler)   Durable Object')).toBe(
    'env.SCHEDULER (Scheduler)   Durable Object',
  )
})

const base = {
  directory: '/app',
  stateDir: '/app/.bunderstack/dev',
  ports: { app: 5173, api: 9001, db: 9002 },
  binaries: { celld: '/bin/celld', sqld: '/bin/sqld', esbuild: '/bin/esbuild' },
}

test('with Vite: sqld, celld, and Vite with the API proxy', () => {
  const plan = planDev({ ...base, userEnv: {}, hasVite: true })
  expect(plan.appUrl).toBe('http://localhost:5173')
  expect(plan.apiUrl).toBe('http://127.0.0.1:9001')
  expect(plan.databaseUrl).toBe('http://127.0.0.1:9002')
  expect(plan.sqld?.cmd).toEqual([
    '/bin/sqld',
    '--http-listen-addr',
    '127.0.0.1:9002',
    '-d',
    '/app/.bunderstack/dev/db',
  ])
  expect(plan.worker.cmd.slice(0, 5)).toEqual([
    '/bin/celld',
    'dev',
    '/app',
    '--port',
    '9001',
  ])
  expect(plan.worker.env).toEqual({ CELLD_ESBUILD: '/bin/esbuild' })
  expect(plan.vite?.cmd).toContain('--strictPort')
  expect(plan.vite?.env).toEqual({
    BUNDERSTACK_DEV_API_URL: 'http://127.0.0.1:9001',
  })
})

test('without Vite: celld serves the static assets and is the app URL', () => {
  const plan = planDev({ ...base, userEnv: {}, hasVite: false })
  expect(plan.vite).toBeUndefined()
  expect(plan.appUrl).toBe(plan.apiUrl)
})

test('a database URL from .env replaces sqld', () => {
  const plan = planDev({
    ...base,
    userEnv: { BUNDERSTACK_DATABASE_URL: 'libsql://team.turso.io' },
    hasVite: true,
  })
  expect(plan.sqld).toBeUndefined()
  expect(plan.databaseUrl).toBe('libsql://team.turso.io')
})

test('runBuild requires a current blueprint and writes wrangler.json from it', async () => {
  const tempRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(tempRoot, 'bunderstack-build-'))
  await mkdir(join(directory, 'src'), { recursive: true })
  const index = join(import.meta.dir, '..', 'index.ts')
  const libsql = join(import.meta.dir, '..', 'database', 'libsql.ts')
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'probe-worker',
      scripts: { build: 'bunderstack build' },
      dependencies: { bunderstack: 'workspace:*' },
    }),
  )
  await writeFile(
    join(directory, 'src/bunderstack.ts'),
    [
      `import { bunderstack } from ${JSON.stringify(index)}`,
      `import { libsql } from ${JSON.stringify(libsql)}`,
      `export const backend = bunderstack({ schema: {}, database: { adapter: libsql() } })`,
    ].join('\n'),
  )
  try {
    // No blueprint: build fails and writes nothing.
    expect(await runBuild({ directory })).toBe(1)
    expect(await Bun.file(join(directory, 'wrangler.json')).exists()).toBe(
      false,
    )

    await generateBlueprint({ directory })
    expect(await runBuild({ directory })).toBe(0)
    const config = JSON.parse(
      await readFile(join(directory, 'wrangler.json'), 'utf8'),
    )
    expect(config.name).toBe('probe-worker')

    // A stale blueprint fails, and build does not rewrite it.
    await writeFile(join(directory, 'bunderstack.blueprint.yaml'), 'stale\n')
    expect(await runBuild({ directory })).toBe(1)
    expect(
      await readFile(join(directory, 'bunderstack.blueprint.yaml'), 'utf8'),
    ).toBe('stale\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
