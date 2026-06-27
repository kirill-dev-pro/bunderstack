import type { InferSelect } from 'bunderstack-query'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type * as schema from '~/schema'

import { reactionSummary } from '~/components/ReactionBar'
import { UserAvatar } from '~/components/UserAvatar'
import { openCard } from '~/lib/card-dialog'
import { fileIdFromUrl, isImageMime, thumbnailUrl } from '~/lib/files'

type Card = InferSelect<typeof schema.cards>
type Attachment = InferSelect<typeof schema.attachments>
type Reaction = InferSelect<typeof schema.reactions>

type KanbanCardProps = {
  card: Card
  commentCount: number
  attachmentCount: number
  coverUrl?: string | null
  reactions: Reaction[]
  assigneeName?: string
}

export function KanbanCard({
  card,
  commentCount,
  attachmentCount,
  coverUrl,
  reactions,
  assigneeName,
}: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const fileId = coverUrl ? fileIdFromUrl(coverUrl) : null
  const coverSrc = fileId
    ? thumbnailUrl(fileId, { w: 320, h: 120, format: 'webp' })
    : null

  const { top: reactionTop, total: reactionTotal } = reactionSummary(
    reactions,
    { targetType: 'card', targetId: card.id },
    2,
  )

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      className={`kanban-card${isDragging ? ' is-dragging' : ''}${coverSrc ? ' kanban-card--cover' : ''}`}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return
        e.stopPropagation()
        openCard(card.id)
      }}
    >
      {coverSrc ? (
        <div className="kanban-card-cover">
          <img src={coverSrc} alt="" loading="lazy" />
        </div>
      ) : null}
      <div className="kanban-card-content">
        <p className="kanban-card-title">{card.title}</p>
        <div className="kanban-card-footer">
          <div className="kanban-card-badges">
            {reactionTotal > 0 ? (
              <span className="kanban-badge kanban-badge--reactions">
                {reactionTop.map((g) => g.emoji).join('')}
                {reactionTotal > 1 ? ` ${reactionTotal}` : ''}
              </span>
            ) : null}
            {commentCount > 0 ? (
              <span className="kanban-badge">💬 {commentCount}</span>
            ) : null}
            {attachmentCount > 0 ? (
              <span className="kanban-badge">📎 {attachmentCount}</span>
            ) : null}
          </div>
          {assigneeName ? <UserAvatar name={assigneeName} size={24} /> : null}
        </div>
      </div>
    </button>
  )
}

export function cardCoverFromAttachments(attachments: Attachment[]) {
  const images = attachments
    .filter((a) => a.targetType === 'card' && isImageMime(a.mimeType))
    .sort(
      (a, b) =>
        new Date(a.createdAt ?? 0).getTime() -
        new Date(b.createdAt ?? 0).getTime(),
    )
  return images[0]?.fileUrl ?? null
}
