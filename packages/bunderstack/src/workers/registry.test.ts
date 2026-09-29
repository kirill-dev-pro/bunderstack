import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  registeredWorker,
  registerWorker,
  rememberWorkerEnv,
  resetRegistryForTests,
} from './registry'

beforeEach(() => resetRegistryForTests())
afterEach(() => resetRegistryForTests())

test('the registered Worker is available once it has seen its env', () => {
  const worker = { fetch: async () => new Response('ok') }
  registerWorker(worker)
  expect(registeredWorker()).toBeUndefined()
  const env = { AUTH_SECRET: 'x' }
  rememberWorkerEnv(env)
  expect(registeredWorker()).toEqual({ worker, env })
})
