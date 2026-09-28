import { expect, test } from 'bun:test'
import { createServer } from 'node:net'

import { celldLine, firstFreePort, planDev } from './index'

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
