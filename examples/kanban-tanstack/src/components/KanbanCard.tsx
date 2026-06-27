import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { InferSelect } from 'bunderstack-query'
import type * as schema from '~/schema'

import { openCard } from '~/lib/card-dialog'
import { UserAvatar } from '~/components/UserAvatar'

type Card = InferSelect<typeof schema.cards>

type KanbanCardProps = {
  card: Card
  commentCount: number
  assigneeName?: string
}

function stripMarkdown(text: string) {
  return text.replace(/[#*_`[\]]/g, '').trim()
}

export function KanbanCard({ card, commentCount, assigneeName }: KanbanCardProps) {
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

  const preview = card.description ? stripMarkdown(card.description) : ''

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      className={`kanban-card${isDragging ? ' is-dragging' : ''}`}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return
        e.stopPropagation()
        openCard(card.id)
      }}
    >
      <p className="kanban-card-title">{card.title}</p>
      {preview ? <p className="kanban-card-preview">{preview}</p> : null}
      <div className="kanban-card-footer">
        <div className="kanban-card-badges">
          {commentCount > 0 ? (
            <span className="kanban-badge">{commentCount} comments</span>
          ) : null}
        </div>
        {assigneeName ? (
          <UserAvatar name={assigneeName} size={24} />
        ) : null}
      </div>
    </button>
  )
}
