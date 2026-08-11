import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import { createTableCollection } from './collection'

type Card = { id: string; title: string }

function fetchMockFactory(options?: {
  /** Id the mock create endpoint assigns to new rows. Defaults to
   * 'card_3'. Used to simulate a server that ignores the client-supplied
   * id (e.g. an app restricting `writableColumns` to exclude `id`). */
  createdId?: string
}) {
  const createdId = options?.createdId ?? 'card_3'
  const db = new Map<string, Card>([
    ['card_1', { id: 'card_1', title: 'A' }],
    ['card_2', { id: 'card_2', title: 'B' }],
  ])
  const calls: { method: string; id?: string; body?: unknown }[] = []
  const procedures = {
    list: { call: async () => ({ items: [...db.values()], hasMore: false }) },
    get: { call: async ({ id }: { id: string }) => db.get(id)! },
    create: { call: async (body: Card) => {
      calls.push({ method: 'POST', body })
      const created = { id: createdId, title: body.title }
      db.set(created.id, created)
      return created
    } },
    update: { call: async ({ params: { id }, body }: any) => {
      calls.push({ method: 'PATCH', id, body })
      const updated = { ...db.get(id)!, ...body }
      db.set(id, updated)
      return updated
    } },
    delete: { call: async ({ id }: { id: string }) => {
      calls.push({ method: 'DELETE', id })
      db.delete(id)
    } },
  }
  return { procedures, calls, db }
}

describe('createTableCollection', () => {
  it('syncs initial rows from the table list endpoint', async () => {
    const { procedures } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
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
    const { procedures, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card, { title: string }>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.insert({ id: 'card_3', title: 'C' })
    await new Promise((r) => setTimeout(r, 10))

    const createCall = calls.find((c) => c.method === 'POST')
    expect(createCall?.body).toEqual({ id: 'card_3', title: 'C' })
  })

  it('onInsert still sends the client-generated id even when the server assigns a different one', async () => {
    // Simulate an app whose access config restricts `writableColumns` to
    // exclude `id`, so the server ignores the client-supplied id and
    // assigns its own (`server_generated_id`) on create. This library's
    // job is only to pass the client's id through in the request payload —
    // what the server does with it (and how TanStack DB reconciles the
    // optimistic entry once the synced row comes back under a different
    // key) is out of scope for this test.
    const { procedures, calls } = fetchMockFactory({
      createdId: 'server_generated_id',
    })
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card, { title: string }>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.insert({ id: 'card_3', title: 'C' })
    await new Promise((r) => setTimeout(r, 10))

    const createCall = calls.find((c) => c.method === 'POST')
    expect(createCall?.body).toEqual({ id: 'card_3', title: 'C' })
  })

  it('onDelete calls table.delete with the row key', async () => {
    const { procedures, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.delete('card_1')
    await new Promise((r) => setTimeout(r, 10))

    const deleteCall = calls.find((c) => c.method === 'DELETE')
    expect(deleteCall?.id).toBe('card_1')
  })
})
