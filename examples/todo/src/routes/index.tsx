import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { app } from '~/bunderstack'
import { LoginGate } from '~/components/LoginGate'

/** Env validation: PUBLIC_APP_NAME is checked at boot and fully typed. */
const getAppName = createServerFn({ method: 'GET' }).handler(() => {
  return app.env.PUBLIC_APP_NAME
})

export const Route = createFileRoute('/')({
  loader: async () => ({ appName: await getAppName() }),
  component: HomePage,
})

function HomePage() {
  const { user } = Route.useRouteContext()
  const { appName } = Route.useLoaderData()
  if (!user) return <LoginGate title={appName} />
  return <BoardList appName={appName} userName={user.name} />
}

/** Home screen: the boards you own. Board pages themselves are shared by
 *  link — anyone with the URL becomes a collaborator. */
function BoardList({ appName, userName }: { appName: string; userName: string }) {
  const { api } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')

  // tRPC: only the owner's boards — boards are never listable via CRUD.
  const boardsOptions = api.trpc.myBoards.queryOptions()
  const boards = useQuery(boardsOptions)

  const createBoard = useMutation({
    ...api.trpc.createBoard.mutationOptions(),
    onSuccess: (board) => {
      void queryClient.invalidateQueries({ queryKey: boardsOptions.queryKey })
      void navigate({ to: '/b/$boardId', params: { boardId: board.id } })
    },
  })

  // Auto-CRUD: delete is guarded by the `owner` rule in access.ts.
  const deleteBoard = useMutation(
    api.boards.deleteMutation({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: boardsOptions.queryKey }),
    }),
  )

  const addBoard = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createBoard.mutate({ name: name.trim() }, { onSuccess: () => setName('') })
  }

  return (
    <div className="page">
      <header className="header">
        <h1>{appName}</h1>
        <span>{userName}</span>
      </header>

      <form onSubmit={addBoard} className="new-todo">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name a new board"
        />
        <button type="submit" disabled={createBoard.isPending}>
          Create
        </button>
      </form>

      {boards.isLoading && <p>Loading…</p>}
      {boards.data && boards.data.length === 0 && (
        <p className="muted">No boards yet. Create one above!</p>
      )}

      <ul className="boards">
        {boards.data?.map((board) => (
          <li key={board.id}>
            <Link to="/b/$boardId" params={{ boardId: board.id }}>
              {board.name}
            </Link>
            <span className="muted">
              {board.createdAt.toLocaleDateString()}
            </span>
            <button className="remove" onClick={() => deleteBoard.mutate(board.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
