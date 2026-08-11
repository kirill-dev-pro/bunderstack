import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { getEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { ApiContext } from './context'

import { validateAndResolveAccess } from '../access'
import { createMemoryRealtimePublisher } from '../realtime/publisher'
import { buildRealtimeApiRouter } from './realtime-router'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const access = validateAndResolveAccess(
  { boards },
  { boards: { crud: true, list: 'public', get: 'public' } },
)

function context(request: Request): ApiContext {
  return {
    request,
    getSession: async () => ({ user: null, activeOrganizationId: null }),
  } as ApiContext
}

test('returns no realtime procedure when Publisher is disabled', () => {
  expect(buildRealtimeApiRouter(undefined, access)).toBeUndefined()
})

test('streams Publisher events and resumes through the v2 HTTP handler', async () => {
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const live = publisher.subscribe('change')
  await publisher.publish('change', {
    table: 'boards',
    action: 'update',
    record: { id: 'b1', title: 'first' },
  })
  const firstId = getEventMeta((await live.next()).value)?.id
  await live.return?.()
  await publisher.publish('change', {
    table: 'boards',
    action: 'update',
    record: { id: 'b1', title: 'second' },
  })

  const router = buildRealtimeApiRouter(publisher, access)
  if (!router) throw new Error('expected realtime router')
  const handler = new OpenAPIHandler({ router })
  const controller = new AbortController()
  const request = new Request(
    'http://test/api/realtime?tables=boards',
    {
      headers: { 'Last-Event-ID': firstId ?? '' },
      signal: controller.signal,
    },
  )
  const result = await handler.handle(request, { context: context(request) })
  expect(result.matched).toBe(true)
  expect(result.response?.headers.get('Content-Type')).toContain(
    'text/event-stream',
  )

  const reader = result.response!.body!.getReader()
  let frame = ''
  for (let index = 0; index < 3 && !frame.includes('second'); index++) {
    const chunk = await reader.read()
    frame += new TextDecoder().decode(chunk.value)
  }
  controller.abort()
  await reader.cancel()
  expect(frame).toContain('second')
  expect(frame).toContain(firstId ? 'id:' : 'data:')
})
