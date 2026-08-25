import { onScopeDispose, shallowRef, type ShallowRef } from 'vue'

import type { LiveView, LiveViewSnapshot } from './live-view'

/** Vue owns reactivity; LiveView supplies immutable external snapshots. */
export function useLiveView<T>(
  view: LiveView<T>,
): ShallowRef<LiveViewSnapshot<T>> {
  const state = shallowRef(view.getSnapshot()) as ShallowRef<
    LiveViewSnapshot<T>
  >
  const unsubscribe = view.subscribe(() => {
    state.value = view.getSnapshot()
  })
  onScopeDispose(unsubscribe)
  return state
}
