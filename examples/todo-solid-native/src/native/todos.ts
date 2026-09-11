import { createClient, createLiveView } from 'bunderstack/client'
import { createLiveStore } from 'bunderstack/client-solid'
import { action, createOptimisticStore, onCleanup } from 'solid-js'

import type { App } from '../bunderstack'

const api = createClient<App>()

export type Todo = Awaited<ReturnType<typeof api.todos.create>> & {
  /** Exists only in Solid's optimistic action overlay. */
  pending?: boolean
}

export type TodoApi = {
  todos: Pick<typeof api.todos, 'live' | 'create' | 'update' | 'delete'>
}

export type TodoStore = ReturnType<typeof createTodoStore>

/** A new row cannot be addressed by the backend until creation is acknowledged. */
export const isTemporaryTodo = (todo: Todo) => todo.id.startsWith('pending:')

/**
 * The app-specific layer is now deliberately small: Bunderstack owns the
 * confirmed LiveView and transport lifecycle; Solid owns speculative state.
 */
export function createTodoStore(todoApi: TodoApi = api) {
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
    if (isTemporaryTodo(todo)) return
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
    if (isTemporaryTodo(todo)) return
    setItems((draft) => draft.filter((item) => item.id !== todo.id))
    yield view.mutate(todoApi.todos.delete, { id: todo.id })
  })

  return {
    items,
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
