import type { InferSelect } from 'bunderstack-query'

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from '@tanstack/react-router'
import { asTypeId } from 'bunderstack'
import { BunderstackApiError } from 'bunderstack-query'
import { useEffect, useMemo, useState } from 'react'

import type * as schema from '~/schema'

import { api, listParams, queryClient } from '~/api-client'
import { BoardSettingsDialog } from '~/components/BoardSettingsDialog'
import { CardDialog } from '~/components/CardDialog'
import { cardCoverFromAttachments, KanbanCard } from '~/components/KanbanCard'
import { KanbanShell } from '~/components/KanbanShell'
import { ListColumn } from '~/components/ListColumn'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'
import { boardBackgroundClass } from '~/lib/board-backgrounds'
import { getRealtime } from '~/lib/realtime'
import { authClient } from '~/utils/auth-client'

type Card = InferSelect<typeof schema.cards>
type List = InferSelect<typeof schema.lists>
type Attachment = InferSelect<typeof schema.attachments>

function parseBoardIdParam(raw: string) {
  try {
    return asTypeId('board', raw)
  } catch {
    throw notFound()
  }
}

export const Route = createFileRoute('/boards/$boardId')({
  beforeLoad: ({ context }) => {
    if (!context.user)
      throw redirect({ to: '/login', search: { redirect: undefined } })
  },
  loader: async ({ params }) => {
    const boardId = parseBoardIdParam(params.boardId)
    try {
      const board = await queryClient.ensureQueryData(
        api.boards.getQuery(boardId),
      )
      await Promise.all([
        queryClient.ensureQueryData(
          api.lists.listQuery({ boardId, ...listParams }),
        ),
        queryClient.ensureQueryData(
          api.cards.listQuery({ boardId, limit: 500 }),
        ),
        queryClient.ensureQueryData(api.user.listQuery(listParams)),
      ])
      return board
    } catch (err) {
      if (err instanceof BunderstackApiError && err.status === 404)
        throw notFound()
      throw err
    }
  },
  component: BoardPage,
})

function BoardPage() {
  const { user } = Route.useRouteContext()
  const { boardId: boardIdParam } = Route.useParams()
  const boardId = parseBoardIdParam(boardIdParam)
  const board = Route.useLoaderData()
  const [activeCard, setActiveCard] = useState<Card | null>(null)

  useEffect(() => {
    void getRealtime().subscribe([
      'lists',
      'cards',
      'comments',
      'activity',
      'attachments',
      'reactions',
    ])
  }, [])

  const { data: listsData, isLoading: listsLoading } = useQuery(
    api.lists.listQuery({ boardId, ...listParams }),
  )
  const { data: cardsData } = useQuery(
    api.cards.listQuery({ boardId, limit: 500 }),
  )
  const { data: commentsData } = useQuery(
    api.comments.listQuery({ limit: 500 }),
  )
  const { data: attachmentsData } = useQuery(
    api.attachments.listQuery({ limit: 500 }),
  )
  const { data: reactionsData } = useQuery(
    api.reactions.listQuery({ limit: 500 }),
  )
  const { data: usersData } = useQuery(api.user.listQuery(listParams))

  const { data: members } = useQuery({
    queryKey: ['org-members', boardId],
    queryFn: async () => {
      const org = await authClient.organization.getFullOrganization()
      return org.data?.members ?? []
    },
  })

  const userNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const u of usersData?.items ?? []) {
      map[u.id] = u.name
    }
    return map
  }, [usersData])

  const cardIds = useMemo(
    () => new Set((cardsData?.items ?? []).map((c) => c.id)),
    [cardsData],
  )

  const commentCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of commentsData?.items ?? []) {
      if (!cardIds.has(c.cardId)) continue
      map[c.cardId] = (map[c.cardId] ?? 0) + 1
    }
    return map
  }, [commentsData, cardIds])

  const attachmentCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const a of attachmentsData?.items ?? []) {
      if (a.targetType !== 'card' || !cardIds.has(a.targetId as Card['id']))
        continue
      map[a.targetId] = (map[a.targetId] ?? 0) + 1
    }
    return map
  }, [attachmentsData, cardIds])

  const cardCovers = useMemo(() => {
    const byCard = new Map<string, Attachment[]>()
    for (const a of attachmentsData?.items ?? []) {
      if (a.targetType !== 'card' || !cardIds.has(a.targetId as Card['id']))
        continue
      const arr = byCard.get(a.targetId) ?? []
      arr.push(a)
      byCard.set(a.targetId, arr)
    }
    const map: Record<string, string | null> = {}
    for (const [id, atts] of byCard) {
      map[id] = cardCoverFromAttachments(atts)
    }
    return map
  }, [attachmentsData, cardIds])

  const allReactions = reactionsData?.items ?? []
  const allAttachments = attachmentsData?.items ?? []

  const cardsByList = useMemo(() => {
    const map = new Map<List['id'], Card[]>()
    for (const card of cardsData?.items ?? []) {
      const arr = map.get(card.listId) ?? []
      arr.push(card)
      map.set(card.listId, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position)
    }
    return map
  }, [cardsData])

  const lists = (listsData?.items ?? []).sort((a, b) => a.position - b.position)

  const listNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const l of lists) map[l.id] = l.title
    return map
  }, [lists])

  const [settingsOpen, setSettingsOpen] = useState(false)

  const moveCard = useToastMutation({
    ...api.cards.updateMutation(),
  })

  const logMove = useToastMutation({
    ...api.activity.createMutation(),
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function resolveListId(overId: string): List['id'] | null {
    const list = lists.find((l) => l.id === overId)
    if (list) return list.id
    for (const [listId, cards] of cardsByList) {
      if (cards.some((c) => c.id === overId)) return listId
    }
    return null
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveCard(null)
    const { active, over } = event
    if (!over) return

    const cardId = String(active.id) as Card['id']
    const targetListId = resolveListId(String(over.id))
    if (!targetListId) return

    const card = cardsData?.items?.find((c) => c.id === cardId)
    if (!card || (card.listId === targetListId && over.id === cardId)) return

    const siblings = (cardsByList.get(targetListId) ?? []).filter(
      (c) => c.id !== cardId,
    )
    const newPos = (siblings.at(-1)?.position ?? 0) + 1000

    moveCard.mutate(
      { id: cardId, data: { listId: targetListId, position: newPos } },
      {
        onSuccess: () => {
          logMove.mutate({
            boardId,
            cardId,
            actorId: user!.id,
            type: 'moved',
            data: { listId: targetListId },
          })
        },
      },
    )
  }

  const [newListTitle, setNewListTitle] = useState('')
  const createList = useToastMutation({
    ...api.lists.createMutation({
      onSuccess: () => setNewListTitle(''),
    }),
    successMessage: 'List created',
  })

  const bgClass = boardBackgroundClass(board.background)

  return (
    <KanbanShell user={user!} boardTitle={board.title}>
      <div className={`board-view ${bgClass}`}>
        <div className="board-toolbar">
          <h1>{board.title}</h1>
          <div className="board-toolbar-actions">
            <div className="board-toolbar-members">
              {(members ?? [])
                .slice(0, 5)
                .map((m: { userId: string; user?: { name?: string } }) => (
                  <UserAvatar
                    key={m.userId}
                    name={m.user?.name ?? userNames[m.userId] ?? '?'}
                    size={28}
                  />
                ))}
            </div>
            <Link to="/org/settings" className="outline board-share-btn">
              Share
            </Link>
            <button
              type="button"
              className="outline board-settings-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Board settings"
            >
              ⚙
            </button>
          </div>
        </div>

        <div className="board-workspace">
          <div className="board-columns-wrap">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={({ active }) => {
                const card = cardsData?.items?.find((c) => c.id === active.id)
                if (card) setActiveCard(card)
              }}
              onDragEnd={onDragEnd}
              onDragCancel={() => setActiveCard(null)}
            >
              <div className="board-columns">
                {listsLoading
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="skeleton skeleton-column" />
                    ))
                  : lists.map((list: List, i: number) => (
                      <ListColumn
                        key={list.id}
                        list={list}
                        cards={cardsByList.get(list.id) ?? []}
                        boardId={boardId}
                        colorIndex={i}
                        commentCounts={commentCounts}
                        attachmentCounts={attachmentCounts}
                        cardCovers={cardCovers}
                        cardReactions={allReactions}
                        userNames={userNames}
                      />
                    ))}

                <div className="add-list-form">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!newListTitle.trim()) return
                      const lastPos = lists.at(-1)?.position ?? 0
                      createList.mutate({
                        boardId,
                        title: newListTitle.trim(),
                        position: lastPos + 1000,
                      })
                    }}
                  >
                    <input
                      placeholder="New list title"
                      value={newListTitle}
                      onChange={(e) => setNewListTitle(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="outline"
                      style={{ marginTop: '0.5rem', width: '100%' }}
                      disabled={!newListTitle.trim()}
                    >
                      + Add list
                    </button>
                  </form>
                </div>
              </div>

              <DragOverlay>
                {activeCard ? (
                  <KanbanCard
                    card={activeCard}
                    commentCount={commentCounts[activeCard.id] ?? 0}
                    attachmentCount={attachmentCounts[activeCard.id] ?? 0}
                    coverUrl={cardCovers[activeCard.id]}
                    reactions={allReactions.filter(
                      (r) =>
                        r.targetType === 'card' && r.targetId === activeCard.id,
                    )}
                    assigneeName={
                      activeCard.assigneeId
                        ? userNames[activeCard.assigneeId]
                        : undefined
                    }
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        </div>
      </div>

      <BoardSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        boardId={boardId}
        boardTitle={board.title}
        userNames={userNames}
        members={members ?? []}
        listNames={listNames}
      />
      <CardDialog
        userId={user!.id}
        userNames={userNames}
        listNames={listNames}
        allAttachments={allAttachments}
        allReactions={allReactions}
      />
    </KanbanShell>
  )
}
