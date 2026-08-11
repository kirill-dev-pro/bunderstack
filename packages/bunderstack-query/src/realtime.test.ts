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
          return new Promise<AsyncIterable<RealtimeEvent>>(() => {})
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
  const fallback = setTimeout(() => realtime.close(), 100)

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
  const fallback = setTimeout(() => realtime.close(), 100)

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
