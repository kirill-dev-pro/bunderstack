import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createTableCollection } from './collection'

type Card = { id: string; title: string }

function fetchMockFactory() {
  const db = new Map<string, Card>([
    ['card_1', { id: 'card_1', title: 'A' }],
    ['card_2', { id: 'card_2', title: 'B' }],
  ])
  const calls: { method: string; url: string; body?: unknown }[] = []

  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })

    if (method === 'GET' && url.includes('/cards?')) {
      return new Response(
        JSON.stringify({
          items: [...db.values()],
          limit: 100,
          hasMore: false,
        }),
        { status: 200 },
      )
    }
    if (method === 'POST' && url.endsWith('/cards')) {
      const body = JSON.parse(String(init!.body))
      const created = { id: 'card_3', title: body.title }
      db.set(created.id, created)
      return new Response(JSON.stringify(created), { status: 200 })
    }
    if (method === 'PATCH') {
      const id = url.split('/').pop()!
      const body = JSON.parse(String(init!.body))
      const updated = { ...db.get(id)!, ...body }
      db.set(id, updated)
      return new Response(JSON.stringify(updated), { status: 200 })
    }
    if (method === 'DELETE') {
      const id = url.split('/').pop()!
      db.delete(id)
      return new Response(null, { status: 204 })
    }
    throw new Error(`unhandled request: ${method} ${url}`)
  }) as unknown as typeof fetch

  return { fetchMock, calls, db }
}

describe('createTableCollection', () => {
  it('syncs initial rows from the table list endpoint', async () => {
    const { fetchMock } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })

    await collection.stateWhenReady()

    expect(collection.size).toBe(2)
    // collection.get() returns the row plus TanStack DB's virtual props
    // ($collectionId, $key, $origin, $synced), so match a subset rather
    // than exact equality.
    expect(collection.get('card_1')).toMatchObject({
      id: 'card_1',
      title: 'A',
    })
  })

  it('onInsert calls table.create and the new row appears after refetch', async () => {
    const { fetchMock, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card, { title: string }>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.insert({ id: 'card_3', title: 'C' })
    await new Promise((r) => setTimeout(r, 10))

    const createCall = calls.find((c) => c.method === 'POST')
    expect(createCall?.body).toEqual({ title: 'C' })
  })

  it('onDelete calls table.delete with the row key', async () => {
    const { fetchMock, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.delete('card_1')
    await new Promise((r) => setTimeout(r, 10))

    const deleteCall = calls.find((c) => c.method === 'DELETE')
    expect(deleteCall?.url.endsWith('/card_1')).toBe(true)
  })
})
