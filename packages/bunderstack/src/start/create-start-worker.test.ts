import { expect, test } from 'bun:test'

import { bunderstack } from '../index'
import { registeredWorker, resetRegistryForTests } from '../workers/registry'
import { createStartWorker } from './create-start-worker'

test('routes /api to bunderstack, other paths to Start, and registers the Worker', async () => {
  resetRegistryForTests()
  const backend = bunderstack({
    schema: {},
    database: {
      adapter: {
        dialect: 'sqlite',
        driver: 'libsql',
        async connect() {
          throw new Error('not used')
        },
        async migrate() {},
      },
    } as never,
  })
  const started: string[] = []
  const worker = createStartWorker(backend, async (request) => {
    started.push(new URL(request.url).pathname)
    return new Response('ssr')
  })
  // The env becomes known with the first request, even one that only renders.
  expect(registeredWorker()).toBeUndefined()
  const env = { AUTH_SECRET: 'x' }
  const page = await worker.handler.fetch(
    new Request('https://app.example/boards/1'),
    env,
    { waitUntil() {} },
  )
  expect(registeredWorker()?.env).toBe(env)
  expect(await page.text()).toBe('ssr')
  expect(started).toEqual(['/boards/1'])
  expect(Object.keys(worker.durableObjects).sort()).toEqual([
    'RateLimiter',
    'RealtimeHub',
    'Scheduler',
  ])
})
