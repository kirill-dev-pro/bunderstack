import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import { syncRealtime, type RealtimeEvent } from 'bunderstack/query'

import { agentChatRealtimeTables } from './router'

test('run step events refresh the live activity query', async () => {
  const queryClient = new QueryClient()
  const refreshed: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    refreshed.push(queryKey)
  }) as any

  const api = {
    agentRunSteps: {
      key: () => [['agentRunSteps'], { type: 'query' }],
    },
    realtime: {
      changes: {
        async call(input: { tables: string[] }) {
          return (async function* (): AsyncGenerator<RealtimeEvent> {
            if (input.tables.includes('agentRunSteps')) {
              yield {
                table: 'agentRunSteps',
                action: 'create',
                record: { id: 'step_1', title: 'Thinking' },
              }
            }
          })()
        },
      },
    },
  }

  const realtime = syncRealtime({
    api,
    queryClient,
    tables: agentChatRealtimeTables,
    notifyScheduler: 'sync',
    retryMs: 1_000,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  realtime.close()
  await realtime.done

  expect(refreshed).toContainEqual([['agentRunSteps'], { type: 'query' }])
})
