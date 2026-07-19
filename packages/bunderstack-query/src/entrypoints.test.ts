import { expect, test } from 'bun:test'
import { createClient } from './index'
import { createTRPCClient } from './trpc'
import { createBunderstackSchemaClient } from './schema'

type MockApp = {
  $inferClient?: {
    schema: { users: { id: string } }
    access: undefined
    buckets: 'images'
    trpc: any
  }
}

test('createClient exposes tables and files but no trpc', () => {
  const client = createClient<MockApp>()
  expect(client.files).toBeDefined()
  expect(client.users).toBeDefined()

})

test('createTRPCClient exposes tables, files, and trpc', () => {
  const client = createTRPCClient<MockApp>()
  expect(client.files).toBeDefined()
  expect(client.users).toBeDefined()
  expect(client.trpc).toBeDefined()
})

test('createBunderstackSchemaClient exposes withSchema', () => {
  const client = createBunderstackSchemaClient()
  expect(client.withSchema).toBeDefined()
})
