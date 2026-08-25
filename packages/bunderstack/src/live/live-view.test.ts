import { expect, test } from 'bun:test'

import { createLiveView } from './index'

type Row = { id: string; title: string }

function sseResponse(chunks: string[], hold = false): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        if (!hold) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

const snapshot = frame({
  type: 'snapshot',
  items: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ],
  sort: 'id',
  order: 'asc',
  limit: 100,
  hasMore: false,
})

/** Waits until `check` holds, or fails the test. */
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the view fills from the snapshot and applies deltas', async () => {
  const view = createLiveView<Row>('/api/live/posts', {
    fetch: async () =>
      sseResponse(
        [
          snapshot,
          frame({
            type: 'upsert',
            record: { id: 'c', title: 'C' },
            afterId: 'a',
          }),
        ],
        true,
      ),
  })
  let notifications = 0
  view.subscribe(() => notifications++)

  await until(() => view.getRows().length === 3, 'three rows')
  expect(view.getRows().map((row) => row.id)).toEqual(['a', 'c', 'b'])
  expect(view.getStatus()).toBe('live')
  expect(notifications).toBeGreaterThanOrEqual(2)
  view.close()
})

test('the request carries the input as query parameters', async () => {
  const seen: string[] = []
  const view = createLiveView<Row>('/api/live/posts', {
    input: {
      limit: 10,
      sort: 'rank',
      order: 'desc',
      filters: { userId: 'u1' },
    },
    fetch: async (input) => {
      seen.push(String(input))
      return sseResponse([snapshot], true)
    },
  })
  await until(() => seen.length === 1, 'one request')
  const url = new URL(seen[0]!, 'http://test')
  expect(url.pathname).toBe('/api/live/posts')
  expect(url.searchParams.get('limit')).toBe('10')
  expect(url.searchParams.get('sort')).toBe('rank')
  expect(url.searchParams.get('order')).toBe('desc')
  expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ userId: 'u1' })
  view.close()
})

test('a dropped stream reconnects and the new snapshot heals the view', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/live/posts', {
    backoff: () => 0,
    fetch: async () => {
      attempts++
      // The first connection ends after one frame; the second holds open.
      return attempts === 1
        ? sseResponse([frame({ type: 'remove', id: 'zzz' })])
        : sseResponse([snapshot], true)
    },
  })
  await until(() => view.getRows().length === 2, 'the healed view')
  expect(attempts).toBeGreaterThanOrEqual(2)
  expect(view.getStatus()).toBe('live')
  view.close()
})

test('a failure with nothing on screen reports failed', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/live/posts', {
    backoff: () => 5,
    fetch: async () => {
      attempts++
      if (attempts === 1) return new Response('nope', { status: 500 })
      return sseResponse([snapshot], true)
    },
  })
  await until(() => view.getStatus() === 'failed', 'the failed status')
  expect(view.getError()).toBeDefined()
  await until(() => view.getStatus() === 'live', 'the recovered status')
  expect(view.getRows().length).toBe(2)
  expect(view.getError()).toBeUndefined()
  view.close()
})

test('a drop with rows on screen reports reconnecting', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/live/posts', {
    backoff: () => 50,
    fetch: async () => {
      attempts++
      return attempts === 1
        ? sseResponse([snapshot])
        : sseResponse([snapshot], true)
    },
  })
  await until(() => view.getStatus() === 'reconnecting', 'the reconnect status')
  expect(view.getRows().length).toBe(2)
  view.close()
})

test('patch writes optimistically and notifies once', async () => {
  const view = createLiveView<Row>('/api/live/posts', {
    fetch: async () => sseResponse([snapshot], true),
  })
  await until(() => view.getRows().length === 2, 'the snapshot')
  let notifications = 0
  view.subscribe(() => notifications++)
  view.patch((rows) => {
    rows[0] = { ...rows[0]!, title: 'edited' }
  })
  expect(view.getRows()[0]!.title).toBe('edited')
  expect(notifications).toBe(1)
  view.close()
})

test('unsubscribe stops the listener', async () => {
  const view = createLiveView<Row>('/api/live/posts', {
    fetch: async () => sseResponse([snapshot], true),
  })
  await until(() => view.getRows().length === 2, 'the snapshot')
  let notifications = 0
  const unsubscribe = view.subscribe(() => notifications++)
  unsubscribe()
  view.patch((rows) => rows.pop())
  expect(notifications).toBe(0)
  view.close()
})

test('close stops the loop', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/live/posts', {
    backoff: () => 0,
    fetch: async () => {
      attempts++
      return sseResponse([snapshot])
    },
  })
  await until(() => attempts >= 1, 'the first request')
  view.close()
  const settled = attempts
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(attempts).toBe(settled)
})
