import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

const avatars = sqliteTable('avatars', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull(),
})

type Event = {
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

async function readData<T>(reader: any): Promise<T> {
  const chunk = await reader.read()
  if (chunk.done || !chunk.value) throw new Error('SSE stream ended')
  const frame = new TextDecoder().decode(chunk.value)
  return JSON.parse(frame.replace(/^data: /, '').trim()) as T
}

test('app, tRPC, and job publication share the application SSE broker', async () => {
  const app = await createBunderstack({
    schema: { avatars },
    database: { url: ':memory:', adapter: libsql() },
    realtime: true,
    access: {
      avatars: {
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
      },
    },
    trpc: (t) =>
      t.router({
        markRunning: t.procedure.mutation(async ({ ctx }) => {
          await ctx.realtime.publish(avatars, 'update', {
            id: 'a1',
            userId: 'u1',
            status: 'running',
          })
          return { published: ctx.realtime.enabled }
        }),
      }),
    jobs: (j) =>
      j.define({
        completeAvatar: j.job({
          input: z.object({ id: z.string() }),
          handler: async ({ id }, ctx) => {
            await ctx.realtime.publish(avatars, 'update', {
              id,
              userId: 'u1',
              status: 'completed',
            })
          },
        }),
      }),
  })
  await provision(app, { force: true })

  const stream = await app.handler(new Request('http://test/api/realtime'))
  const reader = stream.body!.getReader()

  try {
    const connect = await readData<{ clientId: string }>(reader)
    const subscribe = await app.handler(
      new Request('http://test/api/realtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: connect.clientId,
          subscriptions: ['avatars'],
        }),
      }),
    )
    expect(subscribe.status).toBe(200)
    expect(app.realtime.enabled).toBe(true)

    await app.realtime.publish(avatars, 'create', {
      id: 'a1',
      userId: 'u1',
      status: 'pending',
    })
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'create',
      table: 'avatars',
      record: { id: 'a1', status: 'pending' },
    })

    const trpc = await app.handler(
      new Request('http://test/api/trpc/markRunning', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: null }),
      }),
    )
    expect(trpc.status).toBe(200)
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'running' },
    })

    await app.jobs.enqueue('completeAvatar', { id: 'a1' })
    await app.jobs.tick()
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'completed' },
    })
  } finally {
    await reader.cancel()
    await app.close()
  }
})

test('app exposes an enabled=false no-op when realtime is not configured', async () => {
  const app = await createBunderstack({
    schema: { avatars },
    database: { url: ':memory:', adapter: libsql() },
  })

  expect(app.realtime.enabled).toBe(false)
  await expect(
    app.realtime.publish(avatars, 'update', {
      id: 'a1',
      userId: 'u1',
      status: 'completed',
    }),
  ).resolves.toBeUndefined()
  await app.close()
})
