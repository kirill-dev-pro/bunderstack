import { createRealtimeClient } from 'bunderstack-query'

import { queryClient } from './query.ts'

const tables = ['boards', 'lists', 'cards', 'comments', 'activity'] as const

let client: ReturnType<typeof createRealtimeClient> | null = null

/** Connect SSE only after auth — avoids EventSource on /login. */
export function getRealtime() {
  if (!client) {
    client = createRealtimeClient({
      baseUrl: '/api',
      queryClient,
      tables: [...tables],
    })
  }
  return client
}

export function closeRealtime() {
  client?.close()
  client = null
}
