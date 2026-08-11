import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'bun:test'

import { createSyncRealtimeClient } from './realtime-sync'

function fakeCollection() {
  const upserts: unknown[] = []
  const deletes: unknown[] = []
  let refetchCount = 0
  return {
    upserts,
    deletes,
    get refetchCount() { return refetchCount },
    utils: {
      writeUpsert: (item: unknown) => upserts.push(item),
      writeDelete: (key: unknown) => deletes.push(key),
      refetch: async () => { refetchCount++ },
    },
  }
}

function apiWith(events: Array<Record<string, unknown>>) {
  return {
    posts: { key: () => ['posts'] },
    realtime: {
      changes: {
        async call() {
          return (async function* () {
            for (const event of events) yield event as any
            await new Promise(() => {})
          })()
        },
      },
    },
  }
}

test('routes create and delete events from the typed iterator', async () => {
  const posts = fakeCollection()
  const realtime = createSyncRealtimeClient({
    api: apiWith([
      { action: 'create', table: 'posts', record: { id: 'p1', title: 'A' } },
      { action: 'delete', table: 'posts', record: { id: 'p2' } },
    ]),
    queryClient: new QueryClient(),
    tables: ['posts'],
    collections: { posts },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(posts.upserts).toEqual([{ id: 'p1', title: 'A' }])
  expect(posts.deletes).toEqual(['p2'])
  realtime.close()
})

test('resolver mode routes events to materialized targets', async () => {
  const seen: unknown[] = []
  const target = {
    applyRealtimeEvent: (action: string, record: Record<string, unknown>) => seen.push([action, record]),
    refetchAll: async () => {},
  }
  const realtime = createSyncRealtimeClient({
    api: apiWith([{ action: 'update', table: 'posts', record: { id: 'p1' } }]),
    queryClient: new QueryClient(),
    tables: ['posts'],
    resolve: () => target as any,
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(seen).toEqual([['update', { id: 'p1' }]])
  realtime.close()
})
