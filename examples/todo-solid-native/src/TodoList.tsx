import { For, Show, createSignal } from 'solid-js'

import { createTodoStore, type Todo } from './native/todos'

/**
 * The component sees one list. Internally it is the optimistic Solid store
 * layered over the SSE-confirmed store; named actions own every mutation.
 */
export default function TodoList() {
  const todos = createTodoStore()

  const [draft, setDraft] = createSignal('')
  const [failure, setFailure] = createSignal('')

  const run = async (mutation: Promise<void>, recover?: () => void) => {
    setFailure('')
    try {
      await mutation
    } catch (error) {
      recover?.()
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const add = (title: string) => {
    setDraft('')
    void run(todos.add(title), () => setDraft(title))
  }

  const toggle = (todo: Todo, done: boolean) => {
    void run(todos.toggle(todo, done))
  }

  const remove = (todo: Todo) => {
    void run(todos.remove(todo))
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const title = draft().trim()
    if (!title) return
    add(title)
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

      <Show when={!todos.connected && todos.ready}>
        <p class="hint">reconnecting…</p>
      </Show>

      <Show when={todos.error}>
        <div class="error">
          <p>{String(todos.error)}</p>
          <button onClick={() => todos.resync()}>Retry</button>
        </div>
      </Show>

      <Show when={!todos.error} fallback={null}>
        <Show when={todos.ready} fallback={<p class="empty">Loading…</p>}>
          <Show
            when={todos.items.length > 0}
            fallback={<p class="empty">Nothing yet.</p>}
          >
            <ul class="todos">
              <For each={todos.items}>
                {(todo) => (
                  <li
                    class={{ done: todo.done, pending: !!todo.pending }}
                    aria-busy={todo.pending ? 'true' : undefined}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onInput={(event) =>
                          toggle(todo, event.currentTarget.checked)
                        }
                      />
                      <span>{todo.title}</span>
                    </label>
                    <button
                      class="remove"
                      aria-label={`Delete ${todo.title}`}
                      onClick={() => remove(todo)}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>

      <Show when={failure()}>
        <p class="error">{failure()}</p>
      </Show>
    </>
  )
}
