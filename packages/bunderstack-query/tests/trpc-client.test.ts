// src/trpc-client.test.ts — full round trip against a real bunderstack app.
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { QueryClient } from '@tanstack/react-query'
import { createBunderstack } from 'bunderstack'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { libsql } from 'bunderstack/database/libsql'

import { createTRPCClient } from '../src/trpc'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

const app = await createBunderstack({
  schema: { notes },
  database: { adapter: libsql(), url: ':memory:' },
  trpc: (t) =>
    t.router({
      hello: t.procedure
        .input(z.object({ name: z.string() }))
        .query(({ input }) => ({
          greeting: `hi ${input.name}`,
          at: new Date('2026-01-02T03:04:05Z'),
        })),
      bump: t.procedure
        .input(z.object({ n: z.number() }))
        .mutation(({ input }) => ({ n: input.n + 1 })),
    }),
})

// Route the client's fetch straight into the server handler.
const fetchViaApp = (async (input: RequestInfo | URL, init?: RequestInit) =>
  app.handler(
    new Request(input instanceof Request ? input : String(input), init),
  )) as unknown as typeof fetch

const api = createTRPCClient<typeof app>({
  baseUrl: 'http://test/api',
  fetch: fetchViaApp,
  queryClient: new QueryClient(),
})

test('trpc queryOptions has a stable key and working queryFn', async () => {
  const options = api.trpc.hello.queryOptions({ name: 'bun' })
  expect(JSON.stringify(options.queryKey)).toContain('hello')
  const result = await new QueryClient().fetchQuery(options)
  expect(result.greeting).toBe('hi bun')
  expect(result.at).toBeInstanceOf(Date) // superjson round trip
})

test('trpc mutationOptions executes the mutation', async () => {
  const options = api.trpc.bump.mutationOptions()
  const result = await options.mutationFn!({ n: 41 }, undefined as never)
  expect(result.n).toBe(42)
})

test('tables namespace still works alongside trpc', () => {
  expect(typeof api.notes.list).toBe('function')
})
