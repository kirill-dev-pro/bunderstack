import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { api, listParams, queryClient } from '~/api-client'
import { KanbanShell } from '~/components/KanbanShell'
import { useToastMutation } from '~/hooks/useToastMutation'
import { boardTileClass } from '~/lib/board-backgrounds'
import { getRealtime } from '~/lib/realtime'
import { authClient } from '~/utils/auth-client'

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (!context.user)
      throw redirect({ to: '/login', search: { redirect: undefined } })
  },
  loader: async () => {
    await queryClient.ensureQueryData(
      api.boards.listQuery({ ...listParams, limit: 50 }),
    )
  },
  component: BoardsPage,
})

function formatDate(date: Date | null | undefined) {
  if (!date) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date))
}

function BoardsPage() {
  const { user } = Route.useRouteContext()
  const [title, setTitle] = useState('')

  useEffect(() => {
    void (async () => {
      const orgs = await authClient.organization.list()
      const first = orgs.data?.[0]
      if (first) {
        const active = await authClient.organization.getFullOrganization()
        if (!active.data?.id) {
          await authClient.organization.setActive({ organizationId: first.id })
        }
      }
      await getRealtime().subscribe(['boards'])
    })()
  }, [])

  const { data: pendingInvites } = useQuery({
    queryKey: ['user-invitations'],
    queryFn: async () => {
      const res = await authClient.organization.listUserInvitations()
      return res.data ?? []
    },
  })

  const { data, isLoading } = useQuery(
    api.boards.listQuery({ ...listParams, limit: 50 }),
  )

  const createBoard = useToastMutation({
    ...api.boards.createMutation({
      onSuccess: () => setTitle(''),
    }),
    successMessage: 'Board created',
  })

  const boards = data?.items ?? []

  return (
    <KanbanShell user={user!}>
      <div className="boards-page">
        {(pendingInvites?.length ?? 0) > 0 ? (
          <div className="invite-banner">
            <p>
              You have {pendingInvites!.length} pending workspace invitation
              {pendingInvites!.length === 1 ? '' : 's'}.
            </p>
            <Link
              to="/invite/$invitationId"
              params={{ invitationId: pendingInvites![0]!.id }}
            >
              View invitation
            </Link>
          </div>
        ) : null}

        <header className="boards-page-header">
          <h1>Your boards</h1>
          <p>Pick a board or create a new one for your organization.</p>
        </header>

        <div className="board-grid">
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skeleton skeleton-board-tile" />
              ))
            : boards.map((board) => (
                <Link
                  key={board.id}
                  to="/boards/$boardId"
                  params={{ boardId: board.id }}
                  className={`board-tile ${boardTileClass(board.id, board.background)}`}
                >
                  <span className="board-tile-title">{board.title}</span>
                  <span className="board-tile-meta">
                    Created {formatDate(board.createdAt)}
                  </span>
                </Link>
              ))}

          <article className="board-tile board-create-card">
            <form
              className="board-create-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (!title.trim()) return
                createBoard.mutate({ title: title.trim() })
              }}
            >
              <input
                placeholder="New board title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                type="submit"
                disabled={!title.trim() || createBoard.isPending}
              >
                Create board
              </button>
            </form>
          </article>
        </div>

        {!isLoading && boards.length === 0 ? (
          <div className="empty-state" style={{ marginTop: '2rem' }}>
            <h2>No boards yet</h2>
            <p>Create your first board above to get started.</p>
          </div>
        ) : null}
      </div>
    </KanbanShell>
  )
}
