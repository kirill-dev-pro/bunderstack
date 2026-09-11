import { For, Show } from 'solid-js'

import { createTodoForm } from './native/form'
import { createTodoStore, isTemporaryTodo } from './native/todos'

/** One optimistic list; actions keep writes pending until the live frame arrives. */
export default function TodoList() {
  const todos = createTodoStore()
  const form = createTodoForm(todos.add)

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    void form.submit()
  }

  return (
    <>
      <form class="new" onSubmit={submit}>
        <input
          value={form.draft()}
          onInput={(event) => form.setDraft(event.currentTarget.value)}
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

      <Show when={!todos.error}>
        <Show when={todos.ready} fallback={<p class="empty">Loading…</p>}>
          <ul class="todos">
            <For
              each={todos.items}
              fallback={<li class="empty">Nothing yet.</li>}
            >
              {(todo) => (
                <li
                  class={{ done: todo.done, pending: !!todo.pending }}
                  aria-busy={todo.pending ? 'true' : undefined}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={todo.done}
                      disabled={isTemporaryTodo(todo)}
                      onInput={(event) =>
                        void form.run(
                          todos.toggle(todo, event.currentTarget.checked),
                        )
                      }
                    />
                    <span>{todo.title}</span>
                  </label>
                  <button
                    class="remove"
                    aria-label={'Delete ' + todo.title}
                    disabled={isTemporaryTodo(todo)}
                    onClick={() => void form.run(todos.remove(todo))}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={form.failure()}>
        <p class="error" role="alert">
          {form.failure()}
        </p>
      </Show>
    </>
  )
}
