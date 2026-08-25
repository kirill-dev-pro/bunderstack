import { expect, test } from 'bun:test'

import { createSyncRealtimeClient } from './realtime-sync'

function fakeCollection() {
  const upserts: unknown[] = []
  const deletes: unknown[] = []
  let refetchCount = 0
  return {
    upserts,
    deletes,
    get refetchCount() {
      return refetchCount
    },
    utils: {
      writeUpsert: (item: unknown) => upserts.push(item),
      writeDelete: (key: unknown) => deletes.push(key),
      refetch: async () => {
        refetchCount++
      },
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

async function waitFor(
  condition: () => void | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = condition()
      if (res !== false) return
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  if (lastError) throw lastError
  const res = condition()
  if (res === false) throw new Error('waitFor timed out')
}

test('routes create and delete events from the typed iterator', async () => {
  const posts = fakeCollection()
  const realtime = createSyncRealtimeClient({
    api: apiWith([
      { action: 'create', table: 'posts', record: { id: 'p1', title: 'A' } },
      { action: 'delete', table: 'posts', record: { id: 'p2' } },
    ]),
    tables: ['posts'],
    collections: { posts },
  })
  await waitFor(() => {
    expect(posts.upserts).toEqual([{ id: 'p1', title: 'A' }])
    expect(posts.deletes).toEqual(['p2'])
  })
  realtime.close()
})

test('resolver mode routes events to materialized targets', async () => {
  const seen: unknown[] = []
  const target = {
    applyRealtimeEvent: (action: string, record: Record<string, unknown>) =>
      seen.push([action, record]),
    refetchAll: async () => {},
  }
  const realtime = createSyncRealtimeClient({
    api: apiWith([{ action: 'update', table: 'posts', record: { id: 'p1' } }]),
    tables: ['posts'],
    resolve: () => target as any,
  })
  await waitFor(() => {
    expect(seen).toEqual([['update', { id: 'p1' }]])
  })
  realtime.close()
})

