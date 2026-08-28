import { useMutation, useQueryClient } from '@tanstack/solid-query'
import { createDraggable, createDroppable } from '@thisbeyond/solid-dnd'
import { createSignal, For } from 'solid-js'

import { api } from '../lib/query.ts'
import { type OpenCard, showCard } from './CardDialog.tsx'

// solid-dnd ships its primitives as directives; Solid needs them declared to
// keep `use:draggable` typed, and referenced so the import is not elided.
declare module 'solid-js' {
  namespace JSX {
    interface Directives {
      draggable: boolean
      droppable: boolean
    }
  }
}

type ListRow = { id: string; title: string }
type CardRow = OpenCard & { listId: string; position: number }

function Card(props: { card: CardRow }) {
  const draggable = createDraggable(props.card.id)
  return (
    <div
      use:draggable
      style="padding:.5rem; border:1px solid #ddd; border-radius:.375rem; background:#fff; cursor:grab"
      onClick={() => showCard(props.card)}
    >
      {props.card.title}
    </div>
  )
}

export function ListColumn(props: {
  list: ListRow
  cards: CardRow[]
  boardId: string
}) {
  const qc = useQueryClient()
  const droppable = createDroppable(props.list.id)
  const [title, setTitle] = createSignal('')

  const create = useMutation(() => ({
    mutationFn: async () => {
      const last = props.cards.at(-1)?.position ?? 0
      await api.cards.create.call({
        boardId: props.boardId,
        listId: props.list.id,
        title: title(),
        position: last + 1000,
      })
    },
    onSuccess: () => {
      setTitle('')
      qc.invalidateQueries({ queryKey: api.cards.key({ type: 'query' }) })
    },
  }))

  return (
    <section
      use:droppable
      style="min-width:16rem; display:flex; flex-direction:column; gap:.5rem; padding:.5rem; background:#f4f5f7; border-radius:.5rem"
    >
      <h2 style="margin:0; font-size:1rem">{props.list.title}</h2>
      <For each={props.cards}>{(card) => <Card card={card} />}</For>
      <form
        style="display:flex; gap:.25rem"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <input
          placeholder="Add a card"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <button type="submit" disabled={!title()}>
          +
        </button>
      </form>
    </section>
  )
}
