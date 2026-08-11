import { expect, spyOn, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
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

test('app, tRPC, and job publication share the application publisher facade', async () => {
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
  const events: Event[] = []
  spyOn(app.realtime, 'publish').mockImplementation(
    async (table, action, record) => {
      events.push({
        table: getTableName(table),
        action,
        record: record as unknown as Record<string, unknown>,
      })
    },
  )

  try {
    expect(app.realtime.enabled).toBe(true)

    await app.realtime.publish(avatars, 'create', {
      id: 'a1',
      userId: 'u1',
      status: 'pending',
    })
    expect(events.at(-1)).toMatchObject({
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
    expect(events.at(-1)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'running' },
    })

    await app.jobs.enqueue('completeAvatar', { id: 'a1' })
    await app.jobs.tick()
    expect(events.at(-1)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'completed' },
    })
  } finally {
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
