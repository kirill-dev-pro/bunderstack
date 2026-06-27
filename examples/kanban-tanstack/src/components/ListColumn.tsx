import { useDroppable } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useState } from 'react'

import type { InferSelect } from 'bunderstack-query'
import type * as schema from '~/schema'

import { useToastMutation } from '~/hooks/useToastMutation'
import { api } from '~/api-client'

import { KanbanCard } from './KanbanCard'

type Card = InferSelect<typeof schema.cards>
type List = InferSelect<typeof schema.lists>

const COLUMN_COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444']

type ListColumnProps = {
  list: List
  cards: Card[]
  boardId: string
  colorIndex: number
  commentCounts: Record<string, number>
  userNames: Record<string, string>
}

export function ListColumn({
  list,
  cards,
  boardId,
  colorIndex,
  commentCounts,
  userNames,
}: ListColumnProps) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const { setNodeRef, isOver } = useDroppable({ id: list.id })

  const createCard = useToastMutation({
    ...api.cards.createMutation({
      onSuccess: () => {
        setTitle('')
        setAdding(false)
      },
    }),
    successMessage: 'Card created',
  })

  const cardIds = cards.map((c) => c.id)
  const accent = COLUMN_COLORS[colorIndex % COLUMN_COLORS.length]

  return (
    <section className="list-column">
      <div className="list-column-accent" style={{ background: accent }} />
      <header className="list-column-header">
        <h3>{list.title}</h3>
        <span className="list-column-count">{cards.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={`list-column-cards${isOver ? ' is-over' : ''}`}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <KanbanCard
              key={card.id}
              card={card}
              commentCount={commentCounts[card.id] ?? 0}
              assigneeName={
                card.assigneeId ? userNames[card.assigneeId] : undefined
              }
            />
          ))}
        </SortableContext>
      </div>
      <div className="list-add-card">
        {adding ? (
          <form
            className="list-add-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!title.trim()) return
              const lastPos = cards.at(-1)?.position ?? 0
              createCard.mutate({
                boardId,
                listId: list.id,
                title: title.trim(),
                position: lastPos + 1000,
              })
            }}
          >
            <textarea
              placeholder="Card title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={createCard.isPending || !title.trim()}>
              Add card
            </button>
            <button type="button" className="outline" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="outline" onClick={() => setAdding(true)}>
            + Add card
          </button>
        )}
      </div>
    </section>
  )
}
