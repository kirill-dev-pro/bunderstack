import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'
import { createSignal, For, Show } from 'solid-js'

import { api } from '../lib/query.ts'

export type OpenCard = {
  id: string
  title: string
  description?: string | null
  boardId: string
}

const [openCard, setOpenCard] = createSignal<OpenCard | null>(null)

/** Opened from a card in `ListColumn`; the dialog itself lives on the board. */
export function showCard(card: OpenCard) {
  setOpenCard(card)
}

export function CardDialog() {
  const qc = useQueryClient()
  const [body, setBody] = createSignal('')

  const comments = useQuery(() => ({
    ...api.comments.list.queryOptions({
      input: { filters: { cardId: openCard()?.id ?? '' }, limit: 100 },
    }),
    enabled: Boolean(openCard()),
  }))

  const addComment = useMutation(() => ({
    mutationFn: async () => {
      const card = openCard()
      if (!card) return
      await api.comments.create.call({ cardId: card.id, body: body() })
      await api.activity.create.call({
        boardId: card.boardId,
        cardId: card.id,
        type: 'commented',
        data: {},
      })
    },
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: api.comments.key({ type: 'query' }) })
    },
  }))

  return (
    <Show when={openCard()}>
      {(card) => (
        <div
          role="dialog"
          aria-label={card().title}
          style="position:fixed; inset:0; background:rgba(0,0,0,.4); display:grid; place-items:center"
          onClick={(e) => {
            if (e.currentTarget === e.target) setOpenCard(null)
          }}
        >
          <article
            class="ot-container"
            style="background:var(--ot-bg, #fff); padding:1rem; min-width:22rem; max-width:32rem; border-radius:.5rem"
          >
            <header style="display:flex; justify-content:space-between; gap:1rem">
              <h2 style="margin:0">{card().title}</h2>
              <button type="button" onClick={() => setOpenCard(null)}>
                Close
              </button>
            </header>
            <Show when={card().description}>
              <p>{card().description}</p>
            </Show>

            <h3>Comments</h3>
            <ul>
              <For each={comments.data?.items ?? []}>
                {(comment) => <li>{comment.body}</li>}
              </For>
            </ul>
            <form
              style="display:flex; gap:.5rem"
              onSubmit={(e) => {
                e.preventDefault()
                addComment.mutate()
              }}
            >
              <input
                placeholder="Add a comment"
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
              <button type="submit" disabled={!body()}>
                Send
              </button>
            </form>
          </article>
        </div>
      )}
    </Show>
  )
}
