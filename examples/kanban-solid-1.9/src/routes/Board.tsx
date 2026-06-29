import { useParams } from '@solidjs/router'
import { useQuery, useQueryClient } from '@tanstack/solid-query'
import {
  DragDropProvider,
  DragDropSensors,
  closestCenter,
} from '@thisbeyond/solid-dnd'
import { onMount, For, createMemo } from 'solid-js'

import { CardDialog } from '../components/CardDialog.tsx'
import { ListColumn } from '../components/ListColumn.tsx'
import { tableClients } from '../lib/query.ts'
import { getRealtime } from '../lib/realtime.ts'

const { lists: listsC, cards: cardsC, activity: activityC } = tableClients

export function Board() {
  const params = useParams()
  const qc = useQueryClient()
  const boardId = () => params.id

  onMount(async () => {
    await getRealtime().subscribe(['lists', 'cards', 'comments', 'activity'])
  })

  const lists = useQuery(() => ({
    ...listsC.listQuery({ boardId: boardId(), limit: 100 }),
  }))
  const cards = useQuery(() => ({
    ...cardsC.listQuery({ boardId: boardId(), limit: 500 }),
  }))

  const cardsByList = createMemo(() => {
    const map = new Map<string, any[]>()
    for (const c of cards.data?.items ?? []) {
      const arr = map.get(c.listId) ?? []
      arr.push(c)
      map.set(c.listId, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  })

  async function onDragEnd({ draggable, droppable }: any) {
    if (!draggable || !droppable) return
    const cardId = String(draggable.id)
    const targetListId = String(droppable.id)
    const siblings = (cardsByList().get(targetListId) ?? []).filter(
      (c) => c.id !== cardId,
    )
    const newPos = (siblings.at(-1)?.position ?? 0) + 1000
    await cardsC.update(cardId, { listId: targetListId, position: newPos })
    await activityC.create({
      boardId: boardId(),
      cardId,
      type: 'moved',
      data: { listId: targetListId },
    })
    qc.invalidateQueries({ queryKey: cardsC.keys.list({ boardId: boardId() }) })
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
