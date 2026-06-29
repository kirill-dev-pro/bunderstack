import type { InferSelect } from 'bunderstack-query'

import { useQuery } from '@tanstack/react-query'
import { marked } from 'marked'
import { asTypeId } from 'bunderstack'
import { useEffect, useRef, useState } from 'react'

import type * as schema from '~/schema'

import { api } from '~/api-client'
import { ActivityList } from '~/components/ActivityList'
import { AttachmentGallery } from '~/components/AttachmentGallery'
import { ReactionBar } from '~/components/ReactionBar'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'
import { closeCard, useOpenCardId } from '~/lib/card-dialog'
import { uploadFile } from '~/lib/files'
import { authClient } from '~/utils/auth-client'

type Attachment = InferSelect<typeof schema.attachments>
type Reaction = InferSelect<typeof schema.reactions>
type Card = InferSelect<typeof schema.cards>

export function CardDialog({
  userId,
  userNames,
  listNames,
  allAttachments,
  allReactions,
}: {
  userId: NonNullable<Card['assigneeId']>
  userNames: Record<string, string>
  listNames: Record<string, string>
  allAttachments: Attachment[]
  allReactions: Reaction[]
}) {
  const cardId = useOpenCardId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const commentFileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [commentBody, setCommentBody] = useState('')
  const [pendingCommentFiles, setPendingCommentFiles] = useState<
    { fileUrl: string; fileName: string; mimeType: string }[]
  >([])
  const [uploading, setUploading] = useState(false)

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
      setTitle('')
      setDesc('')
      setCommentBody('')
      setPendingCommentFiles([])
    } else if (el.open) {
      el.close()
    }
  }, [cardId])

  const updateCard = useToastMutation({
    ...api.cards.updateMutation(),
    successMessage: 'Card saved',
  })

  const addComment = useToastMutation({
    ...api.comments.createMutation(),
  })

  const addAttachment = useToastMutation({
    ...api.attachments.createMutation(),
  })

  const logActivity = useToastMutation({
    ...api.activity.createMutation(),
  })

  function logCardActivity(type: string, data?: Record<string, unknown>) {
    if (!card) return
    logActivity.mutate({
      boardId: card.boardId,
      cardId: card.id,
      actorId: userId,
      type,
      data,
    })
  }

  const cardAttachments = allAttachments.filter(
    (a) => a.targetType === 'card' && a.targetId === cardId,
  )

  function attachmentsForComment(commentId: string) {
    return allAttachments.filter(
      (a) => a.targetType === 'comment' && a.targetId === commentId,
    )
  }

  async function handleCardUpload(file: File) {
    if (!card) return
    setUploading(true)
    try {
      const uploaded = await uploadFile(file)
      await addAttachment.mutateAsync({
        targetType: 'card',
        targetId: card.id,
        fileUrl: uploaded.url,
        fileName: uploaded.name,
        mimeType: file.type,
        uploaderId: userId,
      })
      logCardActivity('attachment_added', { fileName: uploaded.name })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleCommentFile(file: File) {
    setUploading(true)
    try {
      const uploaded = await uploadFile(file)
      setPendingCommentFiles((prev) => [
        ...prev,
        {
          fileUrl: uploaded.url,
          fileName: uploaded.name,
          mimeType: file.type,
        },
      ])
    } finally {
      setUploading(false)
      if (commentFileRef.current) commentFileRef.current.value = ''
    }
  }

  if (!cardId) return null

  const listName = card ? (listNames[card.listId] ?? 'List') : ''

  return (
    <dialog
      ref={dialogRef}
      className="card-dialog card-dialog--trello"
      onClose={() => closeCard()}
      onClick={(e) => {
        if (e.target === dialogRef.current) closeCard()
      }}
    >
      <div className="card-dialog-inner">
        {card ? (
          <>
            <header className="card-dialog-header">
              <div className="card-dialog-header-main">
                <span className="card-dialog-list-label">
                  in list {listName}
                </span>
                <input
                  className="card-dialog-title-input"
                  value={title || card.title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => {
                    const next = (title || card.title).trim()
                    if (next && next !== card.title) {
                      updateCard.mutate(
                        { id: card.id, data: { title: next } },
                        {
                          onSuccess: () =>
                            logCardActivity('updated', { field: 'title' }),
                        },
                      )
                    }
                  }}
                />
                <ReactionBar
                  target={{ targetType: 'card', targetId: card.id }}
                  reactions={allReactions}
                  currentUserId={userId}
                  onReact={(emoji) => logCardActivity('reacted', { emoji })}
                />
              </div>
              <button
                type="button"
                className="outline card-dialog-close"
                onClick={() => closeCard()}
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div className="card-dialog-body">
              <div className="card-dialog-main">
                <section className="card-dialog-section">
                  <h3 className="card-dialog-section-title">Description</h3>
                  <textarea
                    id="description"
                    rows={4}
                    placeholder="Add a more detailed description…"
                    value={desc || card.description || ''}
                    onChange={(e) => setDesc(e.target.value)}
                  />
                  <button
                    type="button"
                    className="outline"
                    style={{ marginTop: '0.5rem' }}
                    onClick={() => {
                      const description = desc || card.description || ''
                      updateCard.mutate(
                        { id: card.id, data: { description } },
                        {
                          onSuccess: () =>
                            logCardActivity('updated', {
                              field: 'description',
                            }),
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

                {cardAttachments.length > 0 ? (
                  <section className="card-dialog-section">
                    <h3 className="card-dialog-section-title">Attachments</h3>
                    <AttachmentGallery
                      attachments={cardAttachments}
                      currentUserId={userId}
                    />
                  </section>
                ) : null}

                <section className="card-dialog-section">
                  <h3 className="card-dialog-section-title">Activity</h3>
                  <ActivityList
                    cardId={card.id}
                    boardId={card.boardId}
                    userNames={userNames}
                    listNames={listNames}
                    limit={20}
                    emptyLabel="No history for this card yet."
                    enabled={!!cardId}
                  />
                </section>

                <section className="card-dialog-section">
                  <h3 className="card-dialog-section-title">Comments</h3>
                  {(comments?.items ?? []).map((cmt) => (
                    <div key={cmt.id} className="comment-item">
                      <UserAvatar
                        name={userNames[cmt.authorId ?? ''] ?? '?'}
                        size={32}
                      />
                      <div className="comment-item-body">
                        <div className="comment-item-header">
                          <strong>
                            {userNames[cmt.authorId ?? ''] ?? cmt.authorId}
                          </strong>
                          <time>
                            {cmt.createdAt
                              ? new Intl.DateTimeFormat(undefined, {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                }).format(new Date(cmt.createdAt))
                              : ''}
                          </time>
                        </div>
                        <div>{cmt.body}</div>
                        {attachmentsForComment(cmt.id).length > 0 ? (
                          <AttachmentGallery
                            attachments={attachmentsForComment(cmt.id)}
                            currentUserId={userId}
                            compact
                          />
                        ) : null}
                        <ReactionBar
                          target={{ targetType: 'comment', targetId: cmt.id }}
                          reactions={allReactions}
                          currentUserId={userId}
                          compact
                        />
                      </div>
                    </div>
                  ))}
                  <form
                    className="comment-form"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (
                        !commentBody.trim() &&
                        pendingCommentFiles.length === 0
                      )
                        return
                      const body = commentBody.trim() || '(attachment)'
                      const created = await addComment.mutateAsync({
                        cardId: card.id,
                        body,
                        authorId: userId,
                      })
                      for (const f of pendingCommentFiles) {
                        await addAttachment.mutateAsync({
                          targetType: 'comment',
                          targetId: created.id,
                          fileUrl: f.fileUrl,
                          fileName: f.fileName,
                          mimeType: f.mimeType,
                          uploaderId: userId,
                        })
                      }
                      setCommentBody('')
                      setPendingCommentFiles([])
                      void refetchComments()
                      logCardActivity('commented')
                    }}
                  >
                    <textarea
                      placeholder="Write a comment…"
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      rows={2}
                    />
                    {pendingCommentFiles.length > 0 ? (
                      <ul className="pending-attachments">
                        {pendingCommentFiles.map((f, i) => (
                          <li key={i}>{f.fileName}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="comment-form-actions">
                      <input
                        ref={commentFileRef}
                        type="file"
                        className="sr-only"
                        accept="image/*,application/pdf,text/plain"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void handleCommentFile(file)
                        }}
                      />
                      <button
                        type="button"
                        className="outline"
                        onClick={() => commentFileRef.current?.click()}
                        disabled={uploading}
                      >
                        Attach
                      </button>
                      <button
                        type="submit"
                        disabled={
                          addComment.isPending ||
                          uploading ||
                          (!commentBody.trim() &&
                            pendingCommentFiles.length === 0)
                        }
                      >
                        Comment
                      </button>
                    </div>
                  </form>
                </section>
              </div>

              <aside className="card-dialog-sidebar">
                <section className="card-dialog-sidebar-section">
                  <h4>Members</h4>
                  <select
                    value={card.assigneeId ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value
                      const assigneeId = raw
                        ? asTypeId('user', raw)
                        : null
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
                    {(members ?? []).map(
                      (m: { userId: string; user?: { name?: string } }) => (
                        <option key={m.userId} value={m.userId}>
                          {m.user?.name ?? userNames[m.userId] ?? m.userId}
                        </option>
                      ),
                    )}
                  </select>
                </section>

                <section className="card-dialog-sidebar-section">
                  <h4>Attachments</h4>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="sr-only"
                    accept="image/*,application/pdf,text/plain"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void handleCardUpload(file)
                    }}
                  />
                  <button
                    type="button"
                    className="sidebar-action-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? 'Uploading…' : 'Add attachment'}
                  </button>
                </section>
              </aside>
            </div>
          </>
        ) : (
          <div className="skeleton" style={{ height: '12rem' }} />
        )}
      </div>
    </dialog>
  )
}
