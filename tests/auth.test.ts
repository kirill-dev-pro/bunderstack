// tests/auth.test.ts
import { test, expect } from 'bun:test'
import { createAuth } from '../src/auth'
import { createDb } from '../src/db'
import * as schema from '../examples/standalone/schema'

test('createAuth returns an object with a handler function', () => {
  const db = createDb(schema, { url: ':memory:' })
  const auth = createAuth(db, {
    emailPassword: true,
    secret: 'test-secret-at-least-32-chars-long-x',
    providers: {},
  })
  expect(typeof auth.handler).toBe('function')
})
