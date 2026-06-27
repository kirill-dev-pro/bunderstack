import { createRealtimeClient } from 'bunderstack-query'

import { queryClient } from '~/api-client'

const tables = ['boards', 'lists', 'cards', 'comments', 'activity'] as const

let client: ReturnType<typeof createRealtimeClient> | null = null

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
