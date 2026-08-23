import {
  Errored,
  For,
  Loading,
  Show,
  action,
  affects,
  createSignal,
  isPending,
  onSettled,
} from 'solid-js'

import {
  createTodoStore,
  todosCreate,
  todosDelete,
  todosUpdate,
  type Todo,
} from './native/todos'

/**
 * The data layer is two imports: the generated client (api.gen.ts) and one
 * projection store fed by a single async iterator over `/api/todos/live`.
 *
 * - Mutations are linear `action` generators: declare `affects`, write the
 *   optimistic draft, `yield` the fetch. A throw rejects the returned
 *   promise; nothing catches it here — see the listener below.
 * - Successful mutations are never applied locally: the write broadcasts over
 *   SSE and the stream applies the row, exactly as it does for writes made by
 *   any other client.
 * - Pending and error states are not tracked by hand: unsettled reads fall
 *   into `<Loading>`, rejections into `<Errored>`.
 */
export default function TodoList() {
  const todos = createTodoStore()

  const [draft, setDraft] = createSignal('')
  // The ephemeral layer: recoverable notices that survive optimistic rollback.
  const [failure, setFailure] = createSignal('')
  onSettled(() => {
    // Action rejections never enter the reactive graph — `<Errored>` sees
    // reads and render errors only — so this one listener is what gives a
    // failed mutation a face. It also resyncs: an optimistic draft write has
    // already happened by then, and server truth is the arbiter.
    const onRejection = (event: PromiseRejectionEvent) => {
      event.preventDefault()
      setFailure(
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
      )
      todos.resync()
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () =>
      window.removeEventListener('unhandledrejection', onRejection)
  })

  const add = action(function* (title: string) {
    affects(todos.items)
    // Cleared only on success — while in flight `isPending` blocks a second
    // submit anyway, so a failure leaves the user's text untouched.
    yield todosCreate({ title })
    setDraft('')
  })

  const toggle = action(function* (todo: Todo, done: boolean) {
    affects(todos.items)
    todos.patch((draftTodos) => {
      const current = draftTodos.find((item) => item.id === todo.id)
      if (current) current.done = done
    })
    yield todosUpdate(todo.id, { done })
  })

  const remove = action(function* (todo: Todo) {
    affects(todos.items)
    todos.patch((draftTodos) => {
      const index = draftTodos.findIndex((item) => item.id === todo.id)
      if (index !== -1) draftTodos.splice(index, 1)
    })
    yield todosDelete(todo.id)
  })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const title = draft().trim()
    if (!title || isPending(() => todos.items)) return
    void add(title)
  }

  return (
    <>
      <form class="new" onSubmit={submit}>
        <input
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          placeholder="What needs doing?"
          aria-label="New todo"
        />
        <button type="submit" disabled={isPending(() => todos.items)}>
          Add
        </button>
      </form>

      <Show when={!todos.connected}>
        <p class="hint">reconnecting…</p>
      </Show>

      <Errored
        fallback={(error, reset) => (
          <div class="error">
            <p>{String(error())}</p>
            <button onClick={reset}>Retry</button>
          </div>
        )}
      >
        <Loading fallback={<p class="empty">Loading…</p>}>
          <Show
            when={todos.items.length > 0}
            fallback={<p class="empty">Nothing yet.</p>}
          >
            <ul class="todos">
              <For each={todos.items}>
                {(todo) => (
                  <li class={{ done: todo.done }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onInput={(event) =>
                          void toggle(todo, event.currentTarget.checked)
                        }
                      />
                      <span>{todo.title}</span>
                    </label>
                    <button
                      class="remove"
                      aria-label={`Delete ${todo.title}`}
                      onClick={() => void remove(todo)}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Loading>
      </Errored>

      <Show when={failure()}>
        <p class="error">{failure()}</p>
      </Show>
    </>
  )
}
