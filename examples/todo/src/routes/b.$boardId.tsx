import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { asTypeId } from 'bunderstack/typeid'
import { useRef, useState } from 'react'

import { LoginGate } from '~/components/LoginGate'

export const Route = createFileRoute('/b/$boardId')({
  component: BoardPage,
})

/** A board page IS the share link: the unguessable board id in the URL is
 *  the invite. Anyone who opens it picks a username and collaborates. */
function BoardPage() {
  const { boardId } = Route.useParams()
  const { user, api } = Route.useRouteContext()

  // Auto-CRUD get: `public` in access.ts, so the board name renders even
  // before the visitor signs in.
  const board = useQuery(api.boards.getQuery(boardId))

  if (board.isLoading) return <p className="page">Loading…</p>
  if (!board.data) {
    return (
      <div className="page page--center">
        <h1>Board not found</h1>
        <Link to="/">← Home</Link>
      </div>
    )
  }

  if (!user) {
    return (
      <LoginGate
        title={board.data.name}
        hint="Pick a username to join this board"
      />
    )
  }

  return <BoardTodos boardName={board.data.name} userName={user.name} />
}

/** Rendered only when authenticated, so queries never fire logged-out. */
function BoardTodos({
  boardName,
  userName,
}: {
  boardName: string
  userName: string
}) {
  const { boardId } = Route.useParams()
  const { api } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [copied, setCopied] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // tRPC: typed per-board stats, inferred from the server router
  const stats = useQuery(api.trpc.stats.queryOptions({ boardId }))
  // Todo queries auto-invalidate; this keeps the tRPC stats bar in sync too.
  const invalidateAll = () => void queryClient.invalidateQueries()

  // Auto-CRUD, filtered by board: `boardId` is in filterableColumns.
  const todos = useQuery(api.todos.listQuery({ boardId, limit: 100 }))
  const createTodo = useMutation(
    api.todos.createMutation({ onSuccess: invalidateAll }),
  )
  const toggleTodo = useMutation(
    api.todos.updateMutation({ onSuccess: invalidateAll }),
  )
  const deleteTodo = useMutation(
    api.todos.deleteMutation({ onSuccess: invalidateAll }),
  )

  // tRPC: complete = update DB + send notification email in one call
  const completeTodo = useMutation({
    ...api.trpc.complete.mutationOptions(),
    onSuccess: invalidateAll,
  })

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    // Storage: upload to the 'images' bucket, then link the file to the todo
    const uploaded = file ? await api.files.images.upload(file) : null
    createTodo.mutate(
      {
        title: title.trim(),
        boardId: asTypeId('board', boardId),
        authorName: userName,
        imageFileId: uploaded?.fileId ?? null,
      },
      {
        onSuccess: () => {
          setTitle('')
          setFile(null)
          if (fileInput.current) fileInput.current.value = ''
        },
      },
    )
  }

  const share = async () => {
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="page">
      <header className="header">
        <h1>
          <Link to="/">←</Link> {boardName}
        </h1>
        <span>
          <button className="share" onClick={share}>
            {copied ? 'Link copied!' : '🔗 Share'}
          </button>
          {userName}
        </span>
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
              {todo.authorName && (
                <span className="author">{todo.authorName}</span>
              )}
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
