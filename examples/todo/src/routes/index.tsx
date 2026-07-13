import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useRef, useState } from 'react'

import { app } from '~/bunderstack'
import { authClient } from '~/utils/auth-client'

/** Env validation: PUBLIC_APP_NAME is checked at boot and fully typed. */
const getAppName = createServerFn({ method: 'GET' }).handler(() => {
  return app.env.PUBLIC_APP_NAME
})

export const Route = createFileRoute('/')({
  loader: async () => ({ appName: await getAppName() }),
  component: HomePage,
})

/** Username-only auth: anonymous session + display name. No passwords. */
function LoginGate({ appName }: { appName: string }) {
  const router = useRouter()
  const [name, setName] = useState('')

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    await authClient.signIn.anonymous()
    await authClient.updateUser({ name: name.trim() })
    await router.invalidate()
  }

  return (
    <div className="page page--center">
      <h1>{appName}</h1>
      <form onSubmit={login} className="new-todo">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pick a username"
        />
        <button type="submit">Start</button>
      </form>
    </div>
  )
}

function HomePage() {
  const { user } = Route.useRouteContext()
  const { appName } = Route.useLoaderData()
  if (!user) return <LoginGate appName={appName} />
  return <TodoApp appName={appName} userName={user.name} />
}

/** Rendered only when authenticated, so queries never fire logged-out. */
function TodoApp({ appName, userName }: { appName: string; userName: string }) {
  const { api } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // tRPC: typed stats query, inferred from the server router
  const statsOptions = api.trpc.stats.queryOptions()
  const stats = useQuery(statsOptions)
  const invalidateStats = () =>
    void queryClient.invalidateQueries({ queryKey: statsOptions.queryKey })

  // Auto-CRUD: list/create/update/delete. Todo queries auto-invalidate;
  // the extra onSuccess keeps the tRPC stats bar in sync too.
  const todos = useQuery(api.todos.listQuery({ limit: 100 }))
  const createTodo = useMutation(
    api.todos.createMutation({ onSuccess: invalidateStats }),
  )
  const toggleTodo = useMutation(
    api.todos.updateMutation({ onSuccess: invalidateStats }),
  )
  const deleteTodo = useMutation(
    api.todos.deleteMutation({ onSuccess: invalidateStats }),
  )

  // tRPC: complete = update DB + send notification email in one call
  const completeTodo = useMutation({
    ...api.trpc.complete.mutationOptions(),
    onSuccess: () => void queryClient.invalidateQueries(),
  })

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    // Storage: upload to the 'images' bucket, then link the file to the todo
    const uploaded = file ? await api.files.images.upload(file) : null
    createTodo.mutate(
      { title: title.trim(), imageFileId: uploaded?.fileId ?? null },
      {
        onSuccess: () => {
          setTitle('')
          setFile(null)
          if (fileInput.current) fileInput.current.value = ''
        },
      },
    )
  }

  return (
    <div className="page">
      <header className="header">
        <h1>{appName}</h1>
        <span>{userName}</span>
      </header>

      {/* Stats bar — powered by tRPC */}
      {stats.data && (
        <div className="stats">
          <span>
            Total: <strong>{stats.data.total}</strong>
          </span>
          <span>
            Done: <strong>{stats.data.done}</strong>
          </span>
          <span>
            Pending: <strong>{stats.data.pending}</strong>
          </span>
        </div>
      )}

      {/* New todo, with optional image attachment */}
      <form onSubmit={addTodo} className="new-todo">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
        />
        <label className="attach" title="Attach an image">
          {file ? '🖼️' : '📎'}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" disabled={createTodo.isPending}>
          Add
        </button>
      </form>

      {todos.isLoading && <p>Loading…</p>}
      {todos.data && todos.data.items.length === 0 && (
        <p className="muted">No tasks yet. Add one above!</p>
      )}

      <ul className="todos">
        {todos.data?.items.map((todo) => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={() =>
                toggleTodo.mutate({ id: todo.id, data: { done: !todo.done } })
              }
            />
            {/* Storage transforms: sharp resizes on the fly via ?w=&format= */}
            {todo.imageFileId && (
              <a
                href={api.files.images.url(todo.imageFileId)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={api.files.images.url(todo.imageFileId, {
                    w: 80,
                    format: 'webp',
                  })}
                  alt=""
                />
              </a>
            )}
            <span className={todo.done ? 'title title--done' : 'title'}>
              {todo.title}
            </span>
            {!todo.done && (
              <button
                className="complete"
                onClick={() => completeTodo.mutate({ id: todo.id })}
                disabled={completeTodo.isPending}
                title="Mark done & send email"
              >
                ✅ Done
              </button>
            )}
            <button className="remove" onClick={() => deleteTodo.mutate(todo.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
