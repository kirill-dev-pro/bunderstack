import { useParams } from '@solidjs/router'
import { useQuery, useQueryClient } from '@tanstack/solid-query'
import {
  DragDropProvider,
  DragDropSensors,
  closestCenter,
  type DragEvent,
} from '@thisbeyond/solid-dnd'
import { onMount, For, createMemo } from 'solid-js'

import { CardDialog } from '../components/CardDialog.tsx'
import { ListColumn } from '../components/ListColumn.tsx'
import { api } from '../lib/query.ts'
import { getRealtime } from '../lib/realtime.ts'

export function Board() {
  const params = useParams()
  const qc = useQueryClient()
  const boardId = () => params.id

  onMount(async () => {
    await getRealtime().subscribe(['lists', 'cards', 'comments', 'activity'])
  })

  const lists = useQuery(() => ({
    ...api.lists.list.queryOptions({
      input: { filters: { boardId: boardId() }, limit: 100 },
    }),
  }))
  const cards = useQuery(() => ({
    ...api.cards.list.queryOptions({
      input: { filters: { boardId: boardId() }, limit: 200 },
    }),
  }))
  type Card = NonNullable<typeof cards.data>['items'][number]

  const cardsByList = createMemo(() => {
    const map = new Map<string, Card[]>()
    for (const c of cards.data?.items ?? []) {
      const arr = map.get(c.listId) ?? []
      arr.push(c)
      map.set(c.listId, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  })

  async function onDragEnd({ draggable, droppable }: DragEvent) {
    if (!draggable || !droppable) return
    const cardId = String(draggable.id)
    const targetListId = String(droppable.id)
    const siblings = (cardsByList().get(targetListId) ?? []).filter(
      (c) => c.id !== cardId,
    )
    const newPos = (siblings.at(-1)?.position ?? 0) + 1000
    await api.cards.update.call({
      params: { id: cardId },
      query: {},
      headers: {},
      body: { listId: targetListId, position: newPos },
    })
    await api.activity.create.call({
      boardId: boardId(),
      cardId,
      type: 'moved',
      data: { listId: targetListId },
    })
    qc.invalidateQueries({ queryKey: api.cards.key({ type: 'query' }) })
  }

  return (
    <main style="padding: 1rem">
      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <div style="display:flex; gap:1rem; align-items:flex-start; overflow-x:auto">
          <For each={lists.data?.items ?? []}>
            {(list) => (
              <ListColumn
                list={list}
                cards={cardsByList().get(list.id) ?? []}
                boardId={boardId()}
              />
            )}
          </For>
        </div>
      </DragDropProvider>
      <CardDialog />
    </main>
  )
}
