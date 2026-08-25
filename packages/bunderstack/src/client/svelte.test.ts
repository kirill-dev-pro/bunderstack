import { expect, test } from 'bun:test'

import type { LiveView, LiveViewSnapshot } from './live-view'

import { liveStore } from './svelte'

test('Svelte store emits the current and subsequent LiveView snapshots', () => {
  let snapshot: LiveViewSnapshot<{ id: string }> = {
    items: [],
    status: 'connecting',
    error: undefined,
  }
  const listeners = new Set<() => void>()
  const view = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as LiveView<{ id: string }>
  const received: LiveViewSnapshot<{ id: string }>[] = []

  const unsubscribe = liveStore(view).subscribe((value) => received.push(value))
  snapshot = {
    items: [{ id: 'server-id' }],
    status: 'ready',
    error: undefined,
  }
  for (const listener of listeners) listener()
  unsubscribe()

  expect(received).toEqual([
    { items: [], status: 'connecting', error: undefined },
    {
      items: [{ id: 'server-id' }],
      status: 'ready',
      error: undefined,
    },
  ])
  expect(listeners.size).toBe(0)
})
