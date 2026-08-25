import {
  createClient,
  createLiveView,
  type CallOptions,
  type LiveViewFrame,
} from 'bunderstack-client'
import { createLiveStore } from 'bunderstack-client/solid'
import { action, createOptimisticStore, onCleanup } from 'solid-js'

import type { App } from '../bunderstack'

const api = createClient<App>()

export type Todo = {
  id: string
  title: string
  done: boolean
  createdAt: Date
  /** Exists only in Solid's optimistic action overlay. */
  pending?: boolean
}

export type TodoApi = {
  todos: {
    live: (
      input: {
        sort: 'createdAt' | 'done'
        order: 'asc' | 'desc'
        limit: number
      },
      options?: CallOptions,
    ) =>
      | AsyncIterable<LiveViewFrame<Todo>>
      | Promise<AsyncIterable<LiveViewFrame<Todo>>>
    create: (input: { title: string }, options?: CallOptions) => Promise<Todo>
    update: (
      input: { id: string; done: boolean },
      options?: CallOptions,
    ) => Promise<Todo>
    delete: (input: { id: string }, options?: CallOptions) => Promise<void>
  }
}

export type TodoStore = {
  readonly items: readonly Todo[]
  readonly connected: boolean
  readonly ready: boolean
  readonly error: unknown
  add(title: string): Promise<void>
  toggle(todo: Todo, done: boolean): Promise<void>
  remove(todo: Todo): Promise<void>
  resync(): void
}

/**
 * The app-specific layer is now deliberately small: Bunderstack owns the
 * confirmed LiveView and transport lifecycle; Solid owns speculative state.
 */
export function createTodoStore(todoApi: TodoApi = api): TodoStore {
  const view = createLiveView<Todo>({
    subscribe: ({ signal }) =>
      todoApi.todos.live(
        { sort: 'createdAt', order: 'desc', limit: 100 },
        { signal },
      ),
  })
  const confirmed = createLiveStore(view)
  const [items, setItems] = createOptimisticStore<Todo[]>(
    () => confirmed.items as Todo[],
    [],
  )
  onCleanup(() => view.close())

  const add = action(function* (title: string) {
    // This is only a local render key. The canonical Todo ID comes from the
    // database in the acknowledged snapshot.
    setItems((draft) => {
      draft.unshift({
        id: `pending:${crypto.randomUUID()}`,
        title,
        done: false,
        createdAt: new Date(),
        pending: true,
      })
    })
    yield view.mutate(todoApi.todos.create, { title })
  })

  const toggle = action(function* (todo: Todo, done: boolean) {
    setItems((draft) => {
      const current = draft.find((item) => item.id === todo.id)
      if (!current) return
      current.done = done
      current.pending = true
    })
    yield view.mutate(todoApi.todos.update, {
      id: todo.id,
      done,
    })
  })

  const remove = action(function* (todo: Todo) {
    setItems((draft) => draft.filter((item) => item.id !== todo.id))
    yield view.mutate(todoApi.todos.delete, { id: todo.id })
  })

  return {
    get items() {
      return items
    },
    get connected() {
      return confirmed.status === 'ready'
    },
    get ready() {
      return confirmed.status === 'ready' || confirmed.status === 'reconnecting'
    },
    get error() {
      return confirmed.error
    },
    add,
    toggle,
    remove,
    resync: () => view.resync(),
  }
}

export { api }
