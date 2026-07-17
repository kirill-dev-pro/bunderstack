// src/trpc.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { TRPCContext } from './trpc'
import type { EmailFacade } from './email'
import { createTRPC } from './trpc'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})
type Schema = { notes: typeof notes }

const fakeEmail: EmailFacade = { send: async () => ({}) }

function makeCtx(user: TRPCContext<Schema>['user']): TRPCContext<Schema> {
  return {
    db: null as never,
    user,
    env: {},
    email: fakeEmail,
    jobs: { enqueue: async () => ({ id: '' }), tick: async () => {} },
    req: new Request('http://test/'),
  }
}

function makeRouter() {
  const t = createTRPC<Schema>()
  return t.router({
    echo: t.procedure
      .input(z.object({ msg: z.string(), at: z.date() }))
      .query(({ input }) => ({ echoed: input.msg, at: input.at })),
    whoami: t.protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id })),
    bump: t.procedure
      .input(z.object({ n: z.number() }))
      .mutation(({ input }) => ({ n: input.n + 1 })),
  })
}

async function call(user: TRPCContext<Schema>['user'], req: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: makeRouter(),
    createContext: () => makeCtx(user),
  })
}

test('query round-trips Dates through superjson', async () => {
  const caller = makeRouter().createCaller(makeCtx(null))
  const at = new Date('2026-01-01T00:00:00Z')
  const result = await caller.echo({ msg: 'hi', at })
  expect(result.echoed).toBe('hi')
  expect(result.at).toBeInstanceOf(Date)
  expect(result.at.getTime()).toBe(at.getTime())
})

test('protectedProcedure throws UNAUTHORIZED without a user', async () => {
  const caller = makeRouter().createCaller(makeCtx(null))
  expect(caller.whoami()).rejects.toThrow(/UNAUTHORIZED/)
})

test('protectedProcedure narrows ctx.user with a session', async () => {
  const caller = makeRouter().createCaller(
    makeCtx({ id: 'u1', email: 'u@x.y', name: 'U' }),
  )
  const result = await caller.whoami()
  expect(result.id).toBe('u1')
})

test('mutation works over the fetch adapter', async () => {
  const res = await call(
    null,
    new Request('http://test/api/trpc/bump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: { n: 1 } }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    result: { data: { json: { n: number } } }
  }
  expect(body.result.data.json.n).toBe(2)
})
