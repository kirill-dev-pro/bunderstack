import { QueryClient } from '@tanstack/query-core'
import { expect, test } from 'bun:test'

import { syncRealtime, type RealtimeEvent } from './realtime'

/**
 * `apply: 'patch'` writes changes into cached list results instead of
 * refetching them. It may only do so where the cached page is provably the
 * whole result set; anything else falls back to invalidation, so a patch is
 * never silently wrong.
 */

function stream(changes: RealtimeEvent[]): AsyncIterable<RealtimeEvent> {
  return (async function* () {
    for (const change of changes) yield change
  })()
}

function fakeApi(changes: RealtimeEvent[]) {
  let connection = 0
  return {
    todos: {
      key: () => [['todos'], { type: 'query' }],
      list: { key: () => [['todos', 'list'], { type: 'query' }] },
      get: {
        queryKey: ({ input }: any) => [
          ['todos', 'get'],
          { type: 'query', input },
        ],
      },
    },
    realtime: {
      changes: {
        async call() {
          connection++
          if (connection === 1) return stream(changes)
          return new Promise<AsyncIterable<RealtimeEvent>>(() => {})
        },
      },
    },
  }
}

function listKey(input: unknown) {
  return [['todos', 'list'], { type: 'query', input }]
}

/** A complete result: every row fits, so inserts are safe. */
function completeList(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    items,
    hasMore: false,
    limit: 100,
    offset: 0,
    sort: 'createdAt',
    order: 'desc',
    ...extra,
  }
}

/**
 * Waits for every change to be applied rather than for a fixed delay, so the
 * assertions cannot race the stream on a loaded machine.
 */
async function run(
  queryClient: QueryClient,
  changes: RealtimeEvent[],
): Promise<void> {
  const expected = changes.filter((change) => !('type' in change)).length
  let applied = 0
  const handle = syncRealtime({
    api: fakeApi(changes),
    queryClient,
    tables: ['todos'],
    retryMs: 0,
    apply: 'patch',
    onChange: () => {
      applied += 1
    },
  })

  const deadline = Date.now() + 2_000
  while (applied < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  // `onChange` runs at the top of apply; yield so the cache write after it lands.
  await new Promise((resolve) => setTimeout(resolve, 0))
  handle.close()
}

test('inserts a created row at the position the cached sort implies', async () => {
  const queryClient = new QueryClient()
  const input = { limit: 100 }
  queryClient.setQueryData(
    listKey(input),
    completeList([
      { id: 't2', title: 'older', createdAt: new Date('2026-01-02') },
      { id: 't1', title: 'oldest', createdAt: new Date('2026-01-01') },
    ]),
  )

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: { id: 't3', title: 'newest', createdAt: new Date('2026-01-03') },
    },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items.map((item: any) => item.id)).toEqual(['t3', 't2', 't1'])
})

test('respects ascending order when placing a created row', async () => {
  const queryClient = new QueryClient()
  const input = { limit: 100, order: 'asc' }
  queryClient.setQueryData(
    listKey(input),
    completeList(
      [
        { id: 't1', createdAt: new Date('2026-01-01') },
        { id: 't3', createdAt: new Date('2026-01-03') },
      ],
      { order: 'asc' },
    ),
  )

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: { id: 't2', createdAt: new Date('2026-01-02') },
    },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items.map((item: any) => item.id)).toEqual(['t1', 't2', 't3'])
})

test('skips lists whose filters the created row does not match', async () => {
  const queryClient = new QueryClient()
  const matching = { filters: { done: false } }
  const other = { filters: { done: true } }
  queryClient.setQueryData(listKey(matching), completeList([]))
  queryClient.setQueryData(listKey(other), completeList([]))

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: { id: 't1', done: false, createdAt: new Date('2026-01-01') },
    },
  ])

  expect(
    (queryClient.getQueryData(listKey(matching)) as any).items,
  ).toHaveLength(1)
  expect((queryClient.getQueryData(listKey(other)) as any).items).toHaveLength(
    0,
  )
})

test('matches array filters as IN and null as IS NULL', async () => {
  const queryClient = new QueryClient()
  const inFilter = { filters: { status: ['open', 'blocked'] } }
  const nullFilter = { filters: { assignee: null } }
  queryClient.setQueryData(listKey(inFilter), completeList([]))
  queryClient.setQueryData(listKey(nullFilter), completeList([]))

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: {
        id: 't1',
        status: 'blocked',
        assignee: null,
        createdAt: new Date('2026-01-01'),
      },
    },
  ])

  expect(
    (queryClient.getQueryData(listKey(inFilter)) as any).items,
  ).toHaveLength(1)
  expect(
    (queryClient.getQueryData(listKey(nullFilter)) as any).items,
  ).toHaveLength(1)
})

test('removes a row that an update pushed out of a filtered list', async () => {
  const queryClient = new QueryClient()
  const input = { filters: { done: false } }
  queryClient.setQueryData(
    listKey(input),
    completeList([
      { id: 't1', done: false, createdAt: new Date('2026-01-01') },
    ]),
  )

  await run(queryClient, [
    {
      table: 'todos',
      action: 'update',
      record: { id: 't1', done: true, createdAt: new Date('2026-01-01') },
    },
  ])

  expect((queryClient.getQueryData(listKey(input)) as any).items).toEqual([])
})

test('adds a row that an update pulled into a filtered list', async () => {
  const queryClient = new QueryClient()
  const input = { filters: { done: true } }
  queryClient.setQueryData(listKey(input), completeList([]))

  await run(queryClient, [
    {
      table: 'todos',
      action: 'update',
      record: { id: 't1', done: true, createdAt: new Date('2026-01-01') },
    },
  ])

  expect((queryClient.getQueryData(listKey(input)) as any).items).toHaveLength(
    1,
  )
})

test('drops a deleted row and decrements a counted total', async () => {
  const queryClient = new QueryClient()
  const input = { count: true }
  queryClient.setQueryData(
    listKey(input),
    completeList([{ id: 't1' }, { id: 't2' }], { total: 2 }),
  )

  await run(queryClient, [
    { table: 'todos', action: 'delete', record: { id: 't1' } },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items.map((item: any) => item.id)).toEqual(['t2'])
  expect(data.total).toBe(1)
})

test('invalidates rather than inserts when the cached page is partial', async () => {
  const queryClient = new QueryClient()
  const input = { limit: 1 }
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any
  queryClient.setQueryData(
    listKey(input),
    completeList([{ id: 't1', createdAt: new Date('2026-01-01') }], {
      hasMore: true,
      limit: 1,
    }),
  )

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: { id: 't2', createdAt: new Date('2026-01-02') },
    },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items).toHaveLength(1)
  expect(invalidated).toContainEqual(listKey(input))
})

test('invalidates a searched list because q cannot be evaluated client-side', async () => {
  const queryClient = new QueryClient()
  const input = { q: 'urgent' }
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any
  queryClient.setQueryData(listKey(input), completeList([], { q: 'urgent' }))

  await run(queryClient, [
    {
      table: 'todos',
      action: 'create',
      record: { id: 't1', title: 'urgent thing', createdAt: new Date() },
    },
  ])

  expect((queryClient.getQueryData(listKey(input)) as any).items).toHaveLength(
    0,
  )
  expect(invalidated).toContainEqual(listKey(input))
})

test('still writes the detail cache while patching', async () => {
  const queryClient = new QueryClient()
  const record = { id: 't1', title: 'Updated', createdAt: new Date() }

  await run(queryClient, [{ table: 'todos', action: 'update', record }])

  expect(
    queryClient.getQueryData<typeof record>([
      ['todos', 'get'],
      { type: 'query', input: { id: 't1' } },
    ]),
  ).toEqual(record)
})

test('leaves invalidate as the default strategy', async () => {
  const queryClient = new QueryClient()
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async ({ queryKey }: any) => {
    invalidated.push(queryKey)
  }) as any
  queryClient.setQueryData(listKey({}), completeList([]))

  const handle = syncRealtime({
    api: fakeApi([
      {
        table: 'todos',
        action: 'create',
        record: { id: 't1', createdAt: new Date() },
      },
    ]),
    queryClient,
    tables: ['todos'],
    retryMs: 0,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  handle.close()

  expect((queryClient.getQueryData(listKey({})) as any).items).toHaveLength(0)
  expect(invalidated).toContainEqual([['todos'], { type: 'query' }])
})

test('places a tied row as the most recent of its equals', async () => {
  const queryClient = new QueryClient()
  const input = { limit: 100 }
  // `timestamp` columns store seconds, so rows written in the same second tie.
  const tied = new Date('2026-01-02T00:00:00.000Z')
  queryClient.setQueryData(
    listKey(input),
    completeList([
      { id: 't2', createdAt: tied },
      { id: 't1', createdAt: new Date('2026-01-01') },
    ]),
  )

  await run(queryClient, [
    { table: 'todos', action: 'create', record: { id: 't3', createdAt: tied } },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items.map((item: any) => item.id)).toEqual(['t3', 't2', 't1'])
})

test('appends a tied row under ascending order', async () => {
  const queryClient = new QueryClient()
  const input = { order: 'asc' }
  const tied = new Date('2026-01-02T00:00:00.000Z')
  queryClient.setQueryData(
    listKey(input),
    completeList(
      [
        { id: 't1', createdAt: new Date('2026-01-01') },
        { id: 't2', createdAt: tied },
      ],
      { order: 'asc' },
    ),
  )

  await run(queryClient, [
    { table: 'todos', action: 'create', record: { id: 't3', createdAt: tied } },
  ])

  const data = queryClient.getQueryData(listKey(input)) as any
  expect(data.items.map((item: any) => item.id)).toEqual(['t1', 't2', 't3'])
})
