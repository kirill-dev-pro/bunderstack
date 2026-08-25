import { useSyncExternalStore } from 'react'

import type { LiveView, LiveViewSnapshot } from './live-view'

/** React owns scheduling; the shared LiveView remains an external store. */
export function useLiveView<T>(view: LiveView<T>): LiveViewSnapshot<T> {
  return useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
    view.getSnapshot,
  )
}
