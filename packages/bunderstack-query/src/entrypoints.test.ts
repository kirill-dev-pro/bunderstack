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
