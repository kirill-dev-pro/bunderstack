import { expect, test } from 'bun:test'

import { createLiveView, type LiveViewFrame } from './live-view'

type Todo = { id: string; title: string }

function channel<T>() {
  const values: T[] = []
  let wake: (() => void) | undefined
  return {
    push(value: T) {
      values.push(value)
      wake?.()
      wake = undefined
    },
    async *iterate(signal: AbortSignal): AsyncGenerator<T> {
      while (!signal.aborted) {
        if (values.length) {
          yield values.shift()!
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  }
}

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
}

test('live view exposes immutable snapshots folded from server frames', async () => {
  const events = channel<LiveViewFrame<Todo>>()
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) => events.iterate(signal),
  })

  events.push({
    type: 'snapshot',
    items: [{ id: 't1', title: 'one' }],
  })
  await tick()
  expect(view.getSnapshot()).toEqual({
    items: [{ id: 't1', title: 'one' }],
    status: 'ready',
    error: undefined,
  })

  events.push({
    type: 'upsert',
    record: { id: 't1', title: 'edited' },
  })
  await tick()
  expect(view.getSnapshot().items).toEqual([{ id: 't1', title: 'edited' }])

  view.close()
  await view.done
})

test('upsert follows the server-provided placement anchor', async () => {
  const events = channel<LiveViewFrame<Todo>>()
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) => events.iterate(signal),
  })

  events.push({
    type: 'snapshot',
    items: [
      { id: 'a', title: 'first' },
      { id: 'c', title: 'third' },
    ],
  })
  events.push({
    type: 'upsert',
    record: { id: 'b', title: 'second' },
    afterId: 'a',
  })
  await tick()
  await tick()

  expect(view.getSnapshot().items.map((item) => item.id)).toEqual([
    'a',
    'b',
    'c',
  ])
  view.close()
  await view.done
})

test('mutate creates an operation ID and resolves after its realtime acknowledgement', async () => {
  const events = channel<LiveViewFrame<Todo>>()
  const operationIds: string[] = []
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) => events.iterate(signal),
    createOperationId: () => 'op-created-by-client',
  })

  let settled = false
  const mutation = view
    .mutate(
      async (_args: { body: { title: string } }, options) => {
        operationIds.push(options.operationId)
        return { id: 'server-id', title: 'new' }
      },
      { body: { title: 'new' } },
    )
    .then(() => {
      settled = true
    })

  await tick()
  expect(operationIds).toEqual(['op-created-by-client'])
  expect(settled).toBe(false)

  events.push({
    type: 'upsert',
    operationId: 'op-created-by-client',
    record: { id: 'server-id', title: 'new' },
  })
  await mutation
  expect(settled).toBe(true)
  expect(view.getSnapshot().items).toEqual([{ id: 'server-id', title: 'new' }])

  view.close()
  await view.done
})

test('live view reconnects with a fresh snapshot and retains stale data meanwhile', async () => {
  const second = channel<LiveViewFrame<Todo>>()
  let connections = 0
  const view = createLiveView<Todo>({
    retryMs: 0,
    subscribe: ({ signal }) => {
      connections++
      if (connections === 1) {
        return (async function* () {
          yield {
            type: 'snapshot',
            items: [{ id: 't1', title: 'stale' }],
          } as const
          throw new Error('disconnected')
        })()
      }
      return second.iterate(signal)
    },
  })

  for (let attempt = 0; attempt < 20 && connections < 2; attempt++) await tick()
  expect(connections).toBe(2)
  expect(view.getSnapshot().items).toEqual([{ id: 't1', title: 'stale' }])
  expect(view.getSnapshot().status).toBe('reconnecting')
  expect(view.getSnapshot().error).toBeUndefined()

  second.push({
    type: 'snapshot',
    items: [{ id: 't2', title: 'fresh' }],
  })
  await tick()
  expect(view.getSnapshot().items).toEqual([{ id: 't2', title: 'fresh' }])
  expect(view.getSnapshot().status).toBe('ready')

  view.close()
  await view.done
})

test('mutation fails instead of hanging when no realtime acknowledgement arrives', async () => {
  const events = channel<LiveViewFrame<Todo>>()
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) => events.iterate(signal),
    ackTimeoutMs: 1,
  })

  await expect(
    view.mutate(
      async () => ({ id: 't1', title: 'request succeeded' }),
      undefined,
    ),
  ).rejects.toThrow('acknowledgement timed out')

  view.close()
  await view.done
})

test('ack timeout starts after HTTP success, not while the request is in flight', async () => {
  const events = channel<LiveViewFrame<Todo>>()
  let finishRequest!: () => void
  const request = new Promise<void>((resolve) => {
    finishRequest = resolve
  })
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) => events.iterate(signal),
    createOperationId: () => 'op-slow-request',
    ackTimeoutMs: 1,
  })

  const mutation = view.mutate(async () => {
    await request
    return { id: 't1', title: 'slow but successful' }
  }, undefined)
  await new Promise((resolve) => setTimeout(resolve, 5))
  events.push({
    type: 'upsert',
    operationId: 'op-slow-request',
    record: { id: 't1', title: 'slow but successful' },
  })
  await tick()
  finishRequest()

  await expect(mutation).resolves.toEqual({
    id: 't1',
    title: 'slow but successful',
  })
  view.close()
  await view.done
})

test('fresh snapshot acknowledges successful mutations whose event was lost on disconnect', async () => {
  let disconnect!: () => void
  const disconnected = new Promise<void>((resolve) => {
    disconnect = resolve
  })
  const second = channel<LiveViewFrame<Todo>>()
  let connections = 0
  const view = createLiveView<Todo>({
    retryMs: 0,
    createOperationId: () => 'op-lost-event',
    subscribe: ({ signal }) => {
      connections++
      if (connections === 1) {
        return (async function* () {
          yield { type: 'snapshot', items: [] } as const
          await disconnected
          throw new Error('disconnected before operation event')
        })()
      }
      return second.iterate(signal)
    },
  })

  await tick()
  let settled = false
  const mutation = view
    .mutate(async () => ({ id: 'server-id', title: 'created' }), undefined)
    .then(() => {
      settled = true
    })
  await tick()
  expect(settled).toBe(false)

  disconnect()
  for (let attempt = 0; attempt < 20 && connections < 2; attempt++) await tick()
  second.push({
    type: 'snapshot',
    items: [{ id: 'server-id', title: 'created' }],
  })

  await mutation
  expect(settled).toBe(true)
  view.close()
  await view.done
})

test('heartbeat silence triggers a reconnect', async () => {
  let connections = 0
  const view = createLiveView<Todo>({
    retryMs: 0,
    livenessFactor: 2,
    subscribe: ({ signal }) => {
      connections++
      return (async function* () {
        yield { type: 'heartbeat', intervalMs: 2 } as const
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    },
  })

  for (let attempt = 0; attempt < 20 && connections < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(connections).toBeGreaterThanOrEqual(2)

  view.close()
  await view.done
})
