/** Per-key coalescing queue for high-frequency row updates.
 *
 * Cursor-shaped workloads call `collection.update()` many times a second. Sent
 * one-for-one, each call is a request, a database write and a broadcast. This
 * queue holds a single merged slot per row key: while a request is in flight,
 * further updates for that key merge into the slot and go out as one follow-up
 * once it lands. Request frequency settles at `min(update rate, 1/RTT)` without
 * a tuned throttle constant, and the optimistic UI is untouched — only the
 * network is coalesced.
 */

type Waiter = {
  resolve: () => void
  reject: (error: unknown) => void
}

type Slot = {
  changes: Record<string, unknown>
  waiters: Waiter[]
  /** Promise of the running drain loop; never rejects. */
  done: Promise<void> | null
}

export type UpdateQueueConfig<TKey, TRow> = {
  /** Sends one merged batch of changes and resolves with the canonical row. */
  send: (key: TKey, changes: Record<string, unknown>) => Promise<TRow>
  /** Called with the server's row before the batch's waiters resolve. Awaited,
   * so a handler that needs to recover (refetch) finishes first. */
  onResult: (row: TRow) => void | Promise<void>
}

export type UpdateQueue<TKey> = {
  /** Queues changes for `key`. Resolves once a request carrying them lands. */
  enqueue: (key: TKey, changes: Record<string, unknown>) => Promise<void>
  /** Drops changes still queued for `key` (resolving their waiters) and waits
   * for any in-flight request to land. For operations that supersede pending
   * updates and must not race them — a delete of the same row. */
  settle: (key: TKey) => Promise<void>
}

export function createUpdateQueue<TKey, TRow>(
  config: UpdateQueueConfig<TKey, TRow>,
): UpdateQueue<TKey> {
  const slots = new Map<TKey, Slot>()

  async function drain(key: TKey, slot: Slot) {
    while (Object.keys(slot.changes).length > 0) {
      // Taking changes and waiters as one snapshot is what guarantees a waiter
      // resolves only after a request that carried its own changes.
      const changes = slot.changes
      const waiters = slot.waiters
      slot.changes = {}
      slot.waiters = []
      try {
        await config.onResult(await config.send(key, changes))
        for (const waiter of waiters) waiter.resolve()
      } catch (error) {
        // Replaying queued changes on top of a failed base would diverge from
        // the server silently, so the whole key is rolled back instead.
        const queued = slot.waiters
        slot.changes = {}
        slot.waiters = []
        for (const waiter of [...waiters, ...queued]) waiter.reject(error)
      }
    }
    slots.delete(key)
  }

  return {
    enqueue(key, changes) {
      let slot = slots.get(key)
      if (!slot) {
        slot = { changes: {}, waiters: [], done: null }
        slots.set(key, slot)
      }
      Object.assign(slot.changes, changes)
      const promise = new Promise<void>((resolve, reject) => {
        slot!.waiters.push({ resolve, reject })
      })
      if (!slot.done) slot.done = drain(key, slot)
      return promise
    },
    settle(key) {
      const slot = slots.get(key)
      if (!slot) return Promise.resolve()
      const waiters = slot.waiters
      slot.changes = {}
      slot.waiters = []
      for (const waiter of waiters) waiter.resolve()
      return slot.done ?? Promise.resolve()
    },
  }
}
