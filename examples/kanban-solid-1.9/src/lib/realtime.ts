import { syncRealtime } from 'bunderstack-query'

import { api, queryClient } from './query.ts'

const tables = ['boards', 'lists', 'cards', 'comments', 'activity'] as const

let client: ReturnType<typeof syncRealtime> | null = null

/** Connect SSE only after auth — avoids EventSource on /login. */
export function getRealtime() {
  if (!client) {
    client = syncRealtime({
      api,
      queryClient,
      tables: [...tables],
    })
  }
  return { subscribe: async (_tables: string[]) => {}, close: client.close }
}

export function closeRealtime() {
  client?.close()
  client = null
}
