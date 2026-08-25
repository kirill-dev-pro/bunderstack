import { createStore, onCleanup, reconcile, type Store } from 'solid-js'

import type { LiveView, LiveViewSnapshot } from './live-view'

/** Mirrors confirmed LiveView snapshots into a keyed Solid store. */
export function createLiveStore<T extends { id: unknown }>(
  view: LiveView<T>,
): Store<LiveViewSnapshot<T>> {
  const initial = view.getSnapshot()
  const [state, setState] = createStore({
    items: [...initial.items],
    status: initial.status,
    error: initial.error,
  })
  const unsubscribe = view.subscribe(() => {
    const next = view.getSnapshot()
    setState((draft) => {
      reconcile([...next.items], (item: T) => item.id)(draft.items)
      draft.status = next.status
      draft.error = next.error
    })
  })
  onCleanup(unsubscribe)
  return state as Store<LiveViewSnapshot<T>>
}
