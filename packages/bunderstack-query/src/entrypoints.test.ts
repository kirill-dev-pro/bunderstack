import { expect, test } from 'bun:test'

import { createClient } from './index'

type MockApp = {
  $inferClient?: {
    schema: Record<string, unknown>
    access: undefined
    buckets: 'images'
    api: any
  }
}

test('the package exposes one client entrypoint', () => {
  expect(typeof createClient<MockApp>).toBe('function')
})

test('removed split-client entrypoints stay removed', async () => {
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
  expect(source).not.toContain('createTRPCClient')
  expect(source).not.toContain('createRealtimeClient')
  expect(source).not.toContain('createBunderstackQueryClient')
})
