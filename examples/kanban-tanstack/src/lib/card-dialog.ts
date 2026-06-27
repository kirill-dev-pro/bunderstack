import { useSyncExternalStore } from 'react'

let openCardId: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openCard(id: string) {
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
