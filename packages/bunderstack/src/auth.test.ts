// tests/auth.test.ts
import { test, expect } from 'bun:test'

import * as schema from '../../../examples/standalone/schema'
import { createAuth } from './auth'
import { createDb } from './db'

test('createAuth returns an object with a handler function', () => {
  const db = createDb(schema, { url: ':memory:' })
  const auth = createAuth(db, {
    emailAndPassword: { enabled: true },
    secret: 'test-secret-at-least-32-chars-long-x',
  })
  expect(typeof auth.handler).toBe('function')
})
