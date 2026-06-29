import { useSyncExternalStore } from 'react'

import type { InferSelect } from 'bunderstack-query'

import type { cards } from '~/schema'

type CardId = InferSelect<typeof cards>['id']

let openCardId: CardId | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openCard(id: CardId) {
  openCardId = id
  emit()
}

export function closeCard() {
  openCardId = null
  emit()
}

export function useOpenCardId() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => openCardId,
    () => null,
  )
}
