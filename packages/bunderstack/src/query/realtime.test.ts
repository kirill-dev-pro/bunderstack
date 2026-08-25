import { withEventMeta } from '@standardserver/core'
import { QueryClient } from '@tanstack/query-core'
import { expect, test } from 'bun:test'

import {
  syncRealtime,
  type RealtimeChange,
  type RealtimeEvent,
  type RealtimeSyncHandle,
} from './realtime'

function stream(changes: RealtimeEvent[]): AsyncIterable<RealtimeEvent> {
  return (async function* () {
    for (const change of changes) yield change
  })()
}

function fakeApi(calls: Array<{ lastEventId?: string }>) {
  let connection = 0
  return {
    cards: {
      key: () => [['cards'], { type: 'query' }],
      get: {
        queryKey: ({ input }: any) => [
          ['cards', 'get'],
          { type: 'query', input },
        ],
      },
    },
    realtime: {
      changes: {
        async call(_input: unknown, options?: { lastEventId?: string }) {
          calls.push({ lastEventId: options?.lastEventId })
          connection++
          if (connection === 1)
            return stream([
              withEventMeta(
                {
                  table: 'cards',
                  action: 'update',
                  record: { id: 'c1', title: 'Updated' },
                },
                { id: 'evt-1' },
              ),
            ])
          return new Promise<AsyncIterable<RealtimeEvent>>((_, reject) => {
            if (options?.signal?.aborted) reject(new Error('aborted'))
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          })
        },
      },
    },
  }
}

test('patches detail cache, invalidates lists, and resumes by Publisher ID', async () => {
  const queryClient = new QueryClient()
  const calls: Array<{ lastEventId?: string }> = []
  const api = fakeApi(calls)
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any
  const realtime = syncRealtime({
    api,
    queryClient,
    tables: ['cards'],
    retryMs: 0,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(
    queryClient.getQueryData([
      ['cards', 'get'],
      { type: 'query', input: { id: 'c1' } },
    ]) as unknown,
  ).toEqual({ id: 'c1', title: 'Updated' })
  expect(invalidated.length).toBeGreaterThan(0)
  expect(calls[1]).toEqual({ lastEventId: 'evt-1' })
  realtime.close()
})

test('delete removes detail state and abort stops iteration', async () => {
  const queryClient = new QueryClient()
  const api = fakeApi([])
  const key = [['cards', 'get'], { type: 'query', input: { id: 'c1' } }]
  queryClient.setQueryData(key, { id: 'c1' })
  api.realtime.changes.call = async () =>
    stream([{ table: 'cards', action: 'delete', record: { id: 'c1' } }])
  const realtime = syncRealtime({ api, queryClient, tables: ['cards'] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  realtime.close()
  await realtime.done
  expect(queryClient.getQueryData(key)).toBeUndefined()
})

test('heartbeat keeps the connection healthy without updating cache state', async () => {
  const queryClient = new QueryClient()
  const received: RealtimeChange[] = []
  const errors: unknown[] = []
  const api = {
    realtime: {
      changes: {
        async call() {
          return stream([{ type: 'heartbeat' }])
        },
      },
    },
  }

  const realtime = syncRealtime({
    api,
    queryClient,
    tables: ['cards'],
    retryMs: 100,
    onChange: (change) => received.push(change),
    onError: (error) => errors.push(error),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  realtime.close()
  await realtime.done

  expect(received).toEqual([])
  expect(errors).toEqual([])
  expect(queryClient.getQueryCache().getAll()).toEqual([])
})

test('reconnect failures use capped exponential backoff with full jitter', async () => {
  const originalRandom = Math.random
  Math.random = () => 0.5
  const retries: Array<{ attempt: number; delayMs: number }> = []
  let realtime: RealtimeSyncHandle
  const fallback = setTimeout(() => realtime.close(), 5000)

  try {
    realtime = syncRealtime({
      api: {
        realtime: {
          changes: {
            async call() {
              throw new Error('offline')
            },
          },
        },
      },
      queryClient: new QueryClient(),
      tables: ['cards'],
      retryMs: 10,
      maxRetryMs: 40,
      onRetry: (retry) => {
        retries.push(retry)
        if (retries.length === 5) realtime.close()
      },
    })
    await realtime.done
  } finally {
    clearTimeout(fallback)
    Math.random = originalRandom
  }

  expect(retries).toEqual([
    { attempt: 1, delayMs: 5 },
    { attempt: 2, delayMs: 10 },
    { attempt: 3, delayMs: 20 },
    { attempt: 4, delayMs: 20 },
    { attempt: 5, delayMs: 20 },
  ])
})

test('receiving a stream event resets reconnect backoff', async () => {
  const originalRandom = Math.random
  Math.random = () => 0.5
  const retries: Array<{ attempt: number; delayMs: number }> = []
  let calls = 0
  let realtime: RealtimeSyncHandle
  const fallback = setTimeout(() => realtime.close(), 5000)

  try {
    realtime = syncRealtime({
      api: {
        realtime: {
          changes: {
            async call() {
              calls++
              if (calls === 2) {
                return stream([
                  { table: 'cards', action: 'update', record: { id: 'c1' } },
                ])
              }
              throw new Error('offline')
            },
          },
        },
      },
      queryClient: new QueryClient(),
      tables: ['cards'],
      retryMs: 10,
      maxRetryMs: 40,
      onRetry: (retry) => {
        retries.push(retry)
        if (retries.length === 3) realtime.close()
      },
    })
    await realtime.done
  } finally {
    clearTimeout(fallback)
    Math.random = originalRandom
  }

  expect(retries).toEqual([
    { attempt: 1, delayMs: 5 },
    { attempt: 1, delayMs: 5 },
    { attempt: 2, delayMs: 10 },
  ])
})

/** One connection that emits `changes`, then a connection that never resolves. */
function burstApi(changes: RealtimeEvent[]) {
  let connection = 0
  return {
    cards: {
      key: () => [['cards'], { type: 'query' }],
      get: {
        queryKey: ({ input }: any) => [
          ['cards', 'get'],
          { type: 'query', input },
        ],
      },
    },
    realtime: {
      changes: {
        async call(_input: unknown, options?: { signal?: AbortSignal }) {
          connection++
          if (connection === 1) return stream(changes)
          return new Promise<AsyncIterable<RealtimeEvent>>((_, reject) => {
            if (options?.signal?.aborted) reject(new Error('aborted'))
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          })
        },
      },
    },
  }
}

function cardChanges(count: number): RealtimeEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    table: 'cards',
    action: 'update' as const,
    record: { id: `c${index}`, title: `Card ${index}` },
  }))
}

test('a burst of changes to one table invalidates it once', async () => {
  const queryClient = new QueryClient()
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any

  const realtime = syncRealtime({
    api: burstApi(cardChanges(50)),
    queryClient,
    tables: ['cards'],
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  realtime.close()
  await realtime.done

  expect(invalidated.length).toBe(1)
})

test('onChange observes every change in arrival order', async () => {
  const queryClient = new QueryClient()
  queryClient.invalidateQueries = (async () => {}) as any
  const seen: RealtimeChange[] = []

  const realtime = syncRealtime({
    api: burstApi(cardChanges(50)),
    queryClient,
    tables: ['cards'],
    onChange: (change) => seen.push(change),
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  realtime.close()
  await realtime.done

  expect(seen.length).toBe(50)
  expect(seen.map((change) => change.record['id'])).toEqual(
    cardChanges(50).map((change) => (change as RealtimeChange).record['id']),
  )
})

test("notifyScheduler 'sync' writes the cache as each change arrives", async () => {
  const queryClient = new QueryClient()
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any

  const realtime = syncRealtime({
    api: burstApi(cardChanges(3)),
    queryClient,
    tables: ['cards'],
    notifyScheduler: 'sync',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  realtime.close()
  await realtime.done

  expect(invalidated.length).toBe(3)
})

test('close flushes buffered changes that the scheduler has not run yet', async () => {
  const queryClient = new QueryClient()
  queryClient.invalidateQueries = (async () => {}) as any

  const realtime = syncRealtime({
    api: burstApi(cardChanges(1)),
    queryClient,
    tables: ['cards'],
    // Long enough that the flush cannot have run on its own.
    notifyScheduler: 60_000,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = queryClient.getQueryData([
    ['cards', 'get'],
    { type: 'query', input: { id: 'c0' } },
  ])

  realtime.close()
  await realtime.done

  expect(before).toBeUndefined()
  expect(
    queryClient.getQueryData([
      ['cards', 'get'],
      { type: 'query', input: { id: 'c0' } },
    ]) as unknown,
  ).toEqual({ id: 'c0', title: 'Card 0' })
})
