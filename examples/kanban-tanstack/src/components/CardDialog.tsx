import { useQuery } from '@tanstack/react-query'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'

import { ActivityList } from '~/components/ActivityList'
import { api } from '~/api-client'
import { useToastMutation } from '~/hooks/useToastMutation'
import { closeCard, useOpenCardId } from '~/lib/card-dialog'
import { authClient } from '~/utils/auth-client'

export function CardDialog({
  userId,
  userNames,
  listNames,
}: {
  userId: string
  userNames: Record<string, string>
  listNames: Record<string, string>
}) {
  const cardId = useOpenCardId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [desc, setDesc] = useState('')
  const [commentBody, setCommentBody] = useState('')

  const { data: card } = useQuery({
    ...api.cards.getQuery(cardId ?? ''),
    enabled: !!cardId,
  })

  const { data: comments, refetch: refetchComments } = useQuery({
    ...api.comments.listQuery({ cardId: cardId ?? '', limit: 100 }),
    enabled: !!cardId,
  })

  const { data: members } = useQuery({
    queryKey: ['org-members'],
    queryFn: async () => {
      const org = await authClient.organization.getFullOrganization()
      return org.data?.members ?? []
    },
    enabled: !!cardId,
  })

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (cardId) {
      if (!el.open) el.showModal()
      setDesc('')
    } else if (el.open) {
      el.close()
    }
  }, [cardId])

  const updateCard = useToastMutation({
    ...api.cards.updateMutation(),
    successMessage: 'Card saved',
  })

  const addComment = useToastMutation({
    ...api.comments.createMutation({
      onSuccess: () => {
        setCommentBody('')
        void refetchComments()
      },
    }),
    successMessage: 'Comment added',
  })

  const logActivity = useToastMutation({
    ...api.activity.createMutation(),
  })

  function logCardActivity(
    type: string,
    data?: Record<string, unknown>,
  ) {
    if (!card) return
    logActivity.mutate({
      boardId: card.boardId,
      cardId: card.id,
      actorId: userId,
      type,
      data,
    })
  }

  if (!cardId) return null

  return (
    <dialog
      ref={dialogRef}
      className="card-dialog"
      onClose={() => closeCard()}
      onClick={(e) => {
        if (e.target === dialogRef.current) closeCard()
      }}
    >
      <div className="card-dialog-inner">
        {card ? (
          <>
            <header className="card-dialog-header">
              <h2>{card.title}</h2>
              <button type="button" className="outline" onClick={() => closeCard()}>
                Close
              </button>
            </header>

            <section className="card-dialog-section">
              <label htmlFor="assignee">Assignee</label>
              <select
                id="assignee"
                value={card.assigneeId ?? ''}
                onChange={(e) => {
                  const assigneeId = e.target.value || null
                  updateCard.mutate(
                    { id: card.id, data: { assigneeId } },
                    {
                      onSuccess: () =>
                        logCardActivity('assigned', { assigneeId }),
                    },
                  )
                }}
              >
                <option value="">Unassigned</option>
                {(members ?? []).map((m: { userId: string; user?: { name?: string } }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user?.name ?? userNames[m.userId] ?? m.userId}
                  </option>
                ))}
              </select>
            </section>

            <section className="card-dialog-section">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                rows={4}
                value={desc || card.description || ''}
                onChange={(e) => setDesc(e.target.value)}
              />
              <button
                type="button"
                style={{ marginTop: '0.5rem' }}
                onClick={() => {
                  const description = desc || card.description || ''
                  updateCard.mutate(
                    { id: card.id, data: { description } },
                    {
                      onSuccess: () =>
                        logCardActivity('updated', { field: 'description' }),
                    },
                  )
                }}
              >
                Save description
              </button>
              {card.description ? (
                <div
                  className="card-dialog-markdown"
                  dangerouslySetInnerHTML={{
                    __html: marked.parse(card.description) as string,
                  }}
                />
              ) : null}
            </section>

            <section className="card-dialog-section">
              <label>Comments</label>
              {(comments?.items ?? []).map((cmt) => (
                <div key={cmt.id} className="comment-item">
                  <strong>{userNames[cmt.authorId ?? ''] ?? cmt.authorId}</strong>
                  <div>{cmt.body}</div>
                </div>
              ))}
              <form
                style={{ marginTop: '0.75rem' }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!commentBody.trim()) return
                  addComment.mutate(
                    { cardId: card.id, body: commentBody.trim(), authorId: userId },
                    {
                      onSuccess: () => logCardActivity('commented'),
                    },
                  )
                }}
              >
                <input
                  placeholder="Write a comment…"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                />
                <button type="submit" style={{ marginTop: '0.35rem' }}>
                  Comment
                </button>
              </form>
            </section>

            <section className="card-dialog-section">
              <label>History</label>
              <ActivityList
                cardId={card.id}
                boardId={card.boardId}
                userNames={userNames}
                listNames={listNames}
                limit={50}
                emptyLabel="No history for this card yet."
                enabled={!!cardId}
              />
            </section>
          </>
        ) : (
          <div className="skeleton" style={{ height: '12rem' }} />
        )}
      </div>
    </dialog>
  )
}
