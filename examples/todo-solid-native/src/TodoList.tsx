import { Errored, For, Loading, Show, createSignal, onSettled } from 'solid-js'

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
 * Mutations are plain async functions. They write optimistically *before*
 * the fetch and nothing after — server truth arrives through the stream —
 * so there is nothing for an `action` transaction to protect and no
 * generator ceremony. A failure rejects into the one listener below, which
 * shows a notice and resyncs server truth.
 */
export default function TodoList() {
  const todos = createTodoStore()

  const [draft, setDraft] = createSignal('')
  // The ephemeral layer: recoverable notices that survive optimistic rollback.
  const [failure, setFailure] = createSignal('')
  onSettled(() => {
    // Fetch rejections never enter the reactive graph — `<Errored>` sees
    // reads and render errors only — so this one listener is what gives a
    // failed mutation a face.
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

  const add = async (title: string) => {
    // Cleared synchronously, before any await: a double click re-enters with
    // an empty draft and is rejected by the guard below, so no in-flight
    // flag is needed. On failure the text goes back.
    setDraft('')
    try {
      await todosCreate({ title })
    } catch (error) {
      setDraft(title)
      throw error
    }
  }

  const toggle = async (todo: Todo, done: boolean) => {
    todos.patch((draftTodos) => {
      const current = draftTodos.find((item) => item.id === todo.id)
      if (current) current.done = done
    })
    await todosUpdate(todo.id, { done })
  }

  const remove = async (todo: Todo) => {
    todos.patch((draftTodos) => {
      const index = draftTodos.findIndex((item) => item.id === todo.id)
      if (index !== -1) draftTodos.splice(index, 1)
    })
    await todosDelete(todo.id)
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const title = draft().trim()
    if (!title) return
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
        <button type="submit">Add</button>
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
