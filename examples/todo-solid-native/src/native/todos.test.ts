import { expect, test } from 'bun:test'
import { createRoot, flush } from 'solid-js'

import { createTodoStore, type Todo, type TodoApi } from './todos'

const todo = (id: string, done: boolean): Todo => ({
  id,
  title: `todo ${id}`,
  done,
  createdAt: new Date(2026, 0, Number(id)),
})

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class FrameQueue {
  private frames: unknown[] = []
  private wake: (() => void) | undefined

  push(frame: unknown) {
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<unknown> {
    while (!signal?.aborted) {
      if (this.frames.length) {
        yield this.frames.shift()
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }
}

function baseApi(stream: FrameQueue): TodoApi {
  return {
    todos: {
      live: (_input, options) => stream.iterate(options?.signal) as never,
      create: async ({ title }) => ({
        ...todo('9', false),
        title,
      }),
      update: async ({ id, done }) => todo(id, done),
      delete: async () => undefined,
    },
  }
}

function mount(api: TodoApi) {
  let store!: ReturnType<typeof createTodoStore>
  const dispose = createRoot((dispose) => {
    store = createTodoStore(api)
    return dispose
  })
  return { store, dispose }
}

async function settleUntil(condition: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await Promise.resolve()
    flush()
    if (condition()) return
  }
  throw new Error('condition did not settle')
}

test('confirmed frames reconcile Todo identity by server ID', async () => {
  const stream = new FrameQueue()
  const { store, dispose } = mount(baseApi(stream))
  stream.push({ type: 'snapshot', items: [todo('1', false)] })
  await settleUntil(() => store.ready)
  const original = store.items[0]

  stream.push({ type: 'upsert', record: todo('1', true) })
  await settleUntil(() => store.items[0]?.done === true)

  expect(store.items[0]).toBe(original)
  dispose()
})

test('a rejected mutation rolls back only its Solid optimistic overlay', async () => {
  const stream = new FrameQueue()
  const update = deferred<Todo>()
  const api = baseApi(stream)
  api.todos.update = () => update.promise
  const { store, dispose } = mount(api)
  stream.push({ type: 'snapshot', items: [todo('1', false)] })
  await settleUntil(() => store.ready)

  const result = store.toggle(store.items[0]!, true)
  flush()
  expect(store.items[0]).toMatchObject({ done: true, pending: true })

  update.reject(new Error('update failed'))
  await expect(result).rejects.toThrow('update failed')
  flush()
  expect(store.items[0]).toEqual(todo('1', false))
  dispose()
})

test('a successful mutation remains pending until its operation is acknowledged', async () => {
  const stream = new FrameQueue()
  const update = deferred<Todo>()
  let operationId = ''
  const api = baseApi(stream)
  api.todos.update = (_input, options) => {
    operationId = options?.operationId ?? ''
    return update.promise
  }
  const { store, dispose } = mount(api)
  stream.push({ type: 'snapshot', items: [todo('1', false)] })
  await settleUntil(() => store.ready)

  let settled = false
  const result = store.toggle(store.items[0]!, true).then(() => {
    settled = true
  })
  flush()
  update.resolve(todo('1', true))
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  expect(settled).toBe(false)

  stream.push({
    type: 'upsert',
    operationId,
    record: todo('1', true),
  })
  await result
  flush()
  expect(store.items[0]).toEqual(todo('1', true))
  dispose()
})

test('optimistic create is replaced by the backend-generated entity ID', async () => {
  const stream = new FrameQueue()
  const creation = deferred<Todo>()
  let operationId = ''
  const api = baseApi(stream)
  api.todos.create = (_input, options) => {
    operationId = options?.operationId ?? ''
    return creation.promise
  }
  const { store, dispose } = mount(api)
  stream.push({ type: 'snapshot', items: [] })
  await settleUntil(() => store.ready)

  const result = store.add('server owns the ID')
  flush()
  expect(store.items[0]?.id).toStartWith('pending:')

  const created = { ...todo('42', false), title: 'server owns the ID' }
  creation.resolve(created)
  stream.push({ type: 'snapshot', operationId, items: [created] })
  await result
  flush()
  expect(store.items).toEqual([created])
  dispose()
})

test('failed delete restores the confirmed row', async () => {
  const stream = new FrameQueue()
  const deletion = deferred<void>()
  const api = baseApi(stream)
  api.todos.delete = () => deletion.promise
  const { store, dispose } = mount(api)
  stream.push({ type: 'snapshot', items: [todo('1', false)] })
  await settleUntil(() => store.ready)

  const result = store.remove(store.items[0]!)
  flush()
  expect(store.items).toHaveLength(0)
  deletion.reject(new Error('delete failed'))
  await expect(result).rejects.toThrow('delete failed')
  flush()
  expect(store.items).toEqual([todo('1', false)])
  dispose()
})
