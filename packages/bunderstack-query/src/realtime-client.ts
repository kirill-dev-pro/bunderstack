import type { QueryClient } from '@tanstack/query-core'

import { createTableClient } from './table-client.ts'

type RealtimeEvent = {
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

export type RealtimeClientConfig = {
  baseUrl: string
  queryClient: QueryClient
  tables: string[]
  fetch?: typeof fetch
  EventSourceImpl?: typeof EventSource
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  const { baseUrl, queryClient, tables } = config
  const fetchFn = config.fetch ?? fetch
  const ES = config.EventSourceImpl ?? EventSource
  const root = baseUrl.replace(/\/$/, '')

  // Per-table key factories (reuse the table-client's key scheme).
  const keysByTable = new Map(
    tables.map((t) => [
      t,
      createTableClient({ tableName: t, baseUrl: root, fetch: fetchFn }).keys,
    ]),
  )

  let clientId: string | null = null
  let lastTopics: string[] = []

  const es = new ES(`${root}/realtime`, { withCredentials: true })

  function apply(evt: RealtimeEvent) {
    const keys = keysByTable.get(evt.table)
    if (!keys) return
    const id = evt.record['id'] as string | number
    if (evt.action === 'delete') {
      queryClient.removeQueries({ queryKey: keys.detail(id) })
    } else {
      queryClient.setQueryData(keys.detail(id), evt.record)
    }
    queryClient.invalidateQueries({ queryKey: keys.lists() })
  }

  es.onmessage = (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { clientId?: string } | RealtimeEvent
    if ('clientId' in data && data.clientId) {
      clientId = data.clientId
      if (lastTopics.length) void postSubscribe(lastTopics)
      return
    }
    apply(data as RealtimeEvent)
  }

  async function postSubscribe(topics: string[]) {
    if (!clientId) return
    await fetchFn(`${root}/realtime`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, subscriptions: topics }),
    })
  }

  return {
    async subscribe(topics: string[]) {
      lastTopics = topics
      await postSubscribe(topics)
    },
    close() {
      es.close()
    },
  }
}
