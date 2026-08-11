import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import { createTableCollection } from './collection'

type Card = { id: string; title: string }

function fetchMockFactory(options?: {
  /** Id the mock create endpoint assigns to new rows. Defaults to
   * 'card_3'. Used to simulate a server that ignores the client-supplied
   * id (e.g. an app restricting `writableColumns` to exclude `id`). */
  createdId?: string
  /** Applied to the row the update endpoint returns, so a test can tell the
   * server's canonical row apart from the optimistic one. */
  transformUpdate?: (row: Card) => Card
}) {
  const createdId = options?.createdId ?? 'card_3'
  const db = new Map<string, Card>([
    ['card_1', { id: 'card_1', title: 'A' }],
    ['card_2', { id: 'card_2', title: 'B' }],
  ])
  const calls: { method: string; id?: string; body?: unknown }[] = []
  const count = (method: string) =>
    calls.filter((call) => call.method === method).length
  const procedures = {
    list: {
      call: async () => {
        calls.push({ method: 'LIST' })
        return { items: [...db.values()], hasMore: false }
      },
    },
    get: { call: async ({ id }: { id: string }) => db.get(id)! },
    create: {
      call: async (body: Card) => {
        calls.push({ method: 'POST', body })
        const created = { id: createdId, title: body.title }
        db.set(created.id, created)
        return created
      },
    },
    update: {
      call: async ({ params: { id }, body }: any) => {
        calls.push({ method: 'PATCH', id, body })
        const merged = { ...db.get(id)!, ...body }
        const updated = options?.transformUpdate?.(merged) ?? merged
        db.set(id, updated)
        return updated
      },
    },
    delete: {
      call: async ({ id }: { id: string }) => {
        calls.push({ method: 'DELETE', id })
        db.delete(id)
      },
    },
  }
  return { procedures, calls, count, db }
}

/** Let the mutation handler and its follow-up writes settle. */
function settled() {
  return new Promise((resolve) => setTimeout(resolve, 10))
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

  it('an update sends one PATCH and does not refetch the table', async () => {
    const { procedures, count } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()
    const listsAfterSync = count('LIST')

    collection.update('card_1', (draft: Card) => {
      draft.title = 'renamed'
    })
    await settled()

    expect(count('PATCH')).toBe(1)
    expect(count('LIST')).toBe(listsAfterSync)
  })

  it('writes the server row from the update response into the store', async () => {
    // The server normalizes the title, so the synced value differs from what
    // the optimistic update wrote — proving the response, not the local guess,
    // is what ends up in the store.
    const { procedures, count } = fetchMockFactory({
      transformUpdate: (row) => ({ ...row, title: row.title.toUpperCase() }),
    })
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()
    const listsAfterSync = count('LIST')

    collection.update('card_1', (draft: Card) => {
      draft.title = 'renamed'
    })
    await settled()

    expect(collection.get('card_1')).toMatchObject({ title: 'RENAMED' })
    expect(count('LIST')).toBe(listsAfterSync)
  })

  it('sends every mutation of a batched transaction, not just the first', async () => {
    const { procedures, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.update(['card_1', 'card_2'], (drafts: Card[]) => {
      drafts[0]!.title = 'A2'
      drafts[1]!.title = 'B2'
    })
    await settled()

    expect(
      calls.filter((call) => call.method === 'PATCH').map((call) => call.id),
    ).toEqual(['card_1', 'card_2'])
  })

  it('coalesces updates to one row that pile up while a request is in flight', async () => {
    const { procedures, calls } = fetchMockFactory()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowUpdate = procedures.update.call
    procedures.update.call = async (input: any) => {
      const result = await slowUpdate(input)
      await gate
      return result
    }
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.update('card_1', (draft: Card) => {
      draft.title = 'first'
    })
    await settled()
    collection.update('card_1', (draft: Card) => {
      draft.title = 'second'
    })
    collection.update('card_1', (draft: Card) => {
      draft.title = 'third'
    })
    await settled()

    // Only the first request has gone out; the other two are still merged.
    expect(calls.filter((call) => call.method === 'PATCH').length).toBe(1)

    release()
    await settled()

    const patches = calls.filter((call) => call.method === 'PATCH')
    expect(patches.length).toBe(2)
    expect(patches[1]!.body).toMatchObject({ title: 'third' })
  })

  it('still refetches when the server assigns a different id on create', async () => {
    const { procedures, count } = fetchMockFactory({
      createdId: 'server_generated_id',
    })
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card, { title: string }>({
      tableName: 'cards',
      procedures,
      queryClient,
    })
    await collection.stateWhenReady()
    const listsAfterSync = count('LIST')

    collection.insert({ id: 'card_3', title: 'C' })
    await settled()

    // writeUpsert cannot retire the optimistic row keyed by the client id, so
    // this case keeps the refetch that reconciles it.
    expect(count('LIST')).toBeGreaterThan(listsAfterSync)
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
