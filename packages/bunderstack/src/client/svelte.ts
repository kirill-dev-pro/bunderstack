import type { LiveView, LiveViewSnapshot } from './live-view'

export type Readable<T> = {
  subscribe(run: (value: T) => void): () => void
}

export function liveStore<T>(view: LiveView<T>): Readable<LiveViewSnapshot<T>> {
  return {
    subscribe(run) {
      run(view.getSnapshot())
      return view.subscribe(() => run(view.getSnapshot()))
    },
  }
}
