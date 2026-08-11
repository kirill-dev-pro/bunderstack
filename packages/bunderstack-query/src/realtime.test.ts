import { withEventMeta } from '@standardserver/core'
import { QueryClient } from '@tanstack/query-core'
import { expect, test } from 'bun:test'

import { syncRealtime, type RealtimeChange } from './realtime'

function stream(changes: RealtimeChange[]): AsyncIterable<RealtimeChange> {
  return (async function* () { for (const change of changes) yield change })()
}

function fakeApi(calls: Array<{ lastEventId?: string }>) {
  let connection = 0
  return {
    cards: {
      key: () => [['cards'], { type: 'query' }],
      get: { queryKey: ({ input }: any) => [['cards', 'get'], { type: 'query', input }] },
    },
    realtime: {
      changes: {
        async call(_input: unknown, options?: { lastEventId?: string }) {
          calls.push({ lastEventId: options?.lastEventId })
          connection++
          if (connection === 1) return stream([withEventMeta({ table: 'cards', action: 'update', record: { id: 'c1', title: 'Updated' } }, { id: 'evt-1' })])
          return new Promise<AsyncIterable<RealtimeChange>>(() => {})
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
  queryClient.invalidateQueries = (async ({ queryKey }: any) => { invalidated.push(queryKey) }) as any
  const realtime = syncRealtime({ api, queryClient, tables: ['cards'], retryMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(queryClient.getQueryData([['cards', 'get'], { type: 'query', input: { id: 'c1' } }]) as unknown).toEqual({ id: 'c1', title: 'Updated' })
  expect(invalidated.length).toBeGreaterThan(0)
  expect(calls[1]).toEqual({ lastEventId: 'evt-1' })
  realtime.close()
})

test('delete removes detail state and abort stops iteration', async () => {
  const queryClient = new QueryClient()
  const api = fakeApi([])
  const key = [['cards', 'get'], { type: 'query', input: { id: 'c1' } }]
  queryClient.setQueryData(key, { id: 'c1' })
  api.realtime.changes.call = async () => stream([{ table: 'cards', action: 'delete', record: { id: 'c1' } }])
  const realtime = syncRealtime({ api, queryClient, tables: ['cards'] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  realtime.close()
  await realtime.done
  expect(queryClient.getQueryData(key)).toBeUndefined()
})
