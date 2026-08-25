import { PGlite } from '@electric-sql/pglite'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { expect, test } from 'bun:test'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'

import type { RealtimeChange } from '../realtime/publisher'

import { validateAndResolveAccess } from '../access'
import { createMemoryRealtimePublisher } from '../realtime/publisher'
import { createApiContext } from './context'
import { buildCrudApiRouter } from './crud-router'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
  rank: integer('rank'),
})

const schema = { posts }

async function setupTestDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      user_id TEXT,
      rank INTEGER
    );
  `)
  return drizzle(client, { schema })
}

function context(request: Request) {
  return createApiContext(
    {
      db: {} as never,
      env: {},
      storage: {} as never,
      email: {} as never,
      jobs: {} as never,
      realtime: {} as never,
      auth: {} as never,
    },
    request,
  )
}

/** Reads SSE data frames until one satisfies `until`, or the cap is hit. */
async function readFrames(
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> },
  until: (frame: Record<string, unknown>) => boolean,
  cap = 20,
): Promise<Record<string, unknown>[]> {
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Record<string, unknown>[] = []
  for (let index = 0; index < cap; index++) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>
        frames.push(frame)
        if (until(frame)) return frames
      }
    }
  }
  return frames
}

function liveAccess(rule: 'public' | 'deny' = 'public') {
  return validateAndResolveAccess(schema, {
    posts: {
      crud: true,
      list: rule,
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
      filterableColumns: ['userId'],
      sortableColumns: ['rank'],
      defaultSort: { column: 'rank', order: 'asc' },
    },
  })
}

test('a live view streams a snapshot and then server-placed changes', async () => {
  const db = await setupTestDb()
  await db.insert(posts).values([
    { id: 'p1', title: 'in view', userId: 'u1', rank: 1 },
    { id: 'p2', title: 'out of view', userId: 'u2', rank: 2 },
    { id: 'p3', title: 'also in view', userId: 'u1', rank: 3 },
  ])

  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess(),
    livePublisher: publisher,
  })
  expect(Object.keys(router.posts)).toContain('live')

  const handler = new OpenAPIHandler({ router })
  const controller = new AbortController()
  const request = new Request(
    `http://test/api/live/posts?filters=${encodeURIComponent(
      JSON.stringify({ userId: 'u1' }),
    )}`,
    { signal: controller.signal },
  )
  const result = await handler.handle(request, { context: context(request) })
  expect(result.matched).toBe(true)
  expect(result.response?.headers.get('Content-Type')).toContain(
    'text/event-stream',
  )

  const reader = result.response!.body!.getReader()
  try {
    const untilSnapshot = await readFrames(reader, (frame) =>
      ['snapshot', 'heartbeat'].includes(String(frame.type)),
    )
    const snapshot = untilSnapshot.find((frame) => frame.type === 'snapshot')!
    expect(snapshot).toBeDefined()
    expect((snapshot.items as { id: string }[]).map((item) => item.id)).toEqual(
      ['p1', 'p3'],
    )
    // Resolved values, not the caller's input: the request sent no sort.
    expect(snapshot.sort).toBe('rank')
    expect(snapshot.order).toBe('asc')
    expect(snapshot.hasMore).toBe(false)
    expect(typeof snapshot.limit).toBe('number')

    // A new row in the middle of the view carries its anchor.
    await publisher.publish('change', {
      table: 'posts',
      action: 'create',
      operationId: 'op-create-p4',
      record: { id: 'p4', title: 'between', userId: 'u1', rank: 2 },
    } satisfies RealtimeChange)
    const untilUpsert = await readFrames(
      reader,
      (frame) => frame.type === 'upsert' || frame.type === 'heartbeat',
    )
    const upsert = untilUpsert.find((frame) => frame.type === 'upsert')!
    expect(upsert).toBeDefined()
    expect(upsert.afterId).toBe('p1')
    expect(upsert.operationId).toBe('op-create-p4')

    // An update that leaves the filters removes the row from the view.
    await publisher.publish('change', {
      table: 'posts',
      action: 'update',
      record: { id: 'p1', title: 'moved out', userId: 'u2', rank: 1 },
    } satisfies RealtimeChange)
    const untilRemove = await readFrames(
      reader,
      (frame) => frame.type === 'remove' || frame.type === 'heartbeat',
    )
    expect(untilRemove.find((frame) => frame.id === 'p1')).toBeDefined()
  } finally {
    controller.abort()
    await reader.cancel()
  }
})

test('a live view denies the deltas when it denies the list', async () => {
  const db = await setupTestDb()
  await db
    .insert(posts)
    .values([{ id: 'p1', title: 'x', userId: 'u1', rank: 1 }])
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess('deny'),
    livePublisher: publisher,
  })
  const handler = new OpenAPIHandler({ router })
  const controller = new AbortController()
  const request = new Request('http://test/api/live/posts', {
    signal: controller.signal,
  })
  const result = await handler.handle(request, { context: context(request) })
  const text = await result.response!.text()
  expect(text).not.toContain('"type":"snapshot"')
  controller.abort()
})

test('the live path leaves every id on the get route reachable', async () => {
  const db = await setupTestDb()
  await db
    .insert(posts)
    .values([{ id: 'live', title: 'x', userId: 'u1', rank: 1 }])
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess(),
    livePublisher: publisher,
  })
  const handler = new OpenAPIHandler({ router })
  const request = new Request('http://test/api/posts/live')
  const result = await handler.handle(request, { context: context(request) })
  expect(result.response?.headers.get('Content-Type')).toContain(
    'application/json',
  )
  expect(await result.response!.json()).toMatchObject({ id: 'live' })
})

test('no live procedure without a publisher', () => {
  const router = buildCrudApiRouter(schema, undefined as never, {
    access: liveAccess(),
  })
  expect((router.posts as unknown as { live?: unknown }).live).toBeUndefined()
})
