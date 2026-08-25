import { syncRealtime } from 'bunderstack/query'

import { api, queryClient } from '~/api-client'

const tables = [
  'boards',
  'lists',
  'cards',
  'comments',
  'activity',
  'attachments',
  'reactions',
]
let client: ReturnType<typeof syncRealtime> | null = null

export function getRealtime() {
  client ??= syncRealtime({ api, queryClient, tables })
  return {
    subscribe: async (_tables: string[]) => {},
    close: () => client?.close(),
  }
}

export function closeRealtime() {
  client?.close()
  client = null
}
