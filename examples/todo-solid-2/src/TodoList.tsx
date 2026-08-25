import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'
import { syncRealtime } from 'bunderstack/query'
import { createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'

import type { App } from './bunderstack'

import { api } from './api'

/**
 * The data layer: generated CRUD through TanStack Solid Query.
 *
 * `api.todos.*` comes from the server's `App` type, so `queryOptions`,
 * `mutationOptions`, and `key` are all typed against the real schema — the
 * only strings in this file are CSS classes.
 *
 * This component is loaded through `clientOnly` in App.tsx, so it never runs
 * during SSR and its queries always have a browser origin to fetch from.
 */
export default function TodoList() {
  const qc = useQueryClient()
  const [draft, setDraft] = createSignal('')

  // One definition, used for both the query and the cache writes below, so
  // the key can never drift out of sync with the query it patches.
  const listOptions = () =>
    api.todos.list.queryOptions({ input: { limit: 100 } })

  const todos = useQuery(listOptions)

  const items = () => todos.data?.items ?? []

  // Progress is derived, not fetched. There is no run record to read: the job
  // writes its state onto the rows it is changing, so counting them is the
  // progress bar. The run is the *claimed* set, so a todo added mid-run stays
  // `idle` and counts as neither finished nor outstanding.
  const claimed = () => items().filter((t) => t.summaryStatus !== 'idle')
  const settled = () =>
    claimed().filter(
      (t) => t.summaryStatus === 'done' || t.summaryStatus === 'failed',
    )
  const running = () => claimed().length > settled().length

  const enrich = useMutation(() => ({
    mutationFn: () => api.enrich.call({}),
  }))

  // Realtime, in one call. `syncRealtime` owns the SSE subscription, the
  // reconnect loop, and Publisher-ID resumption; `apply: 'patch'` writes each
  // change straight into the cached lists instead of refetching them, so a
  // write costs one request. It falls back to invalidation for any list where
  // membership or ordering cannot be decided locally — a text search, or a
  // page that is not the whole result.
  // Passing `App` checks the table names against the schema and types every
  // change: `change.record` here is the todo row, not a bag of unknowns.
  const realtime = syncRealtime<App>({
    api,
    queryClient: qc,
    tables: ['todos'],
    apply: 'patch',
  })
  onCleanup(() => realtime.close())

  const create = useMutation(() => ({
    mutationFn: (title: string) => api.todos.create.call({ title }),
  }))

  const toggle = useMutation(() => ({
    mutationFn: (input: { id: string; done: boolean }) =>
      api.todos.update.call({
        id: input.id,
        done: input.done,
      }),
  }))

  const remove = useMutation(() => ({
    mutationFn: (id: string) => api.todos.delete.call({ id }),
  }))

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const title = draft().trim()
    if (!title) return
    setDraft('')
    create.mutate(title)
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

      <div class="jobs">
        <button
          class="ghost"
          disabled={enrich.isPending || running() || items().length === 0}
          onClick={() => enrich.mutate()}
        >
          Summarise every todo
        </button>

        <Show when={running()}>
          <p class="run">
            <progress value={settled().length} max={claimed().length} />
            <span>
              summarising — {settled().length}/{claimed().length}
            </span>
          </p>
        </Show>
      </div>

      <Switch>
        <Match when={todos.isPending}>
          <p class="empty">Loading…</p>
        </Match>

        <Match when={todos.isError}>
          <div class="error">
            <p>{String(todos.error)}</p>
            <button onClick={() => todos.refetch()}>Retry</button>
          </div>
        </Match>

        <Match when={todos.data}>
          <Show
            when={items().length}
            fallback={<p class="empty">Nothing yet.</p>}
          >
            <ul class="todos">
              <For each={items()}>
                {(todo) => (
                  <li class={{ done: todo.done }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onInput={(event) =>
                          toggle.mutate({
                            id: todo.id,
                            done: event.currentTarget.checked,
                          })
                        }
                      />
                      <span>{todo.title}</span>
                    </label>
                    <button
                      class="remove"
                      aria-label={`Delete ${todo.title}`}
                      onClick={() => remove.mutate(todo.id)}
                    >
                      ×
                    </button>
                    <Show when={todo.summaryStatus !== 'idle'}>
                      <p
                        class={{
                          summary: true,
                          streaming: todo.summaryStatus === 'streaming',
                          failed: todo.summaryStatus === 'failed',
                        }}
                      >
                        {todo.summaryStatus === 'failed'
                          ? 'could not summarise'
                          : (todo.summary ?? '…')}
                      </p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Match>
      </Switch>
    </>
  )
}
