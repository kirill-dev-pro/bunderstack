/**
 * When buffered realtime work runs.
 *
 * `'frame'` coalesces a burst of events into one cache write per animation
 * frame. `'sync'` restores the older behaviour of writing as each event
 * arrives. A number debounces by that many milliseconds.
 */
export type NotifyScheduler = 'sync' | 'frame' | number

/** The timer functions the scheduler needs, injectable so tests control time. */
export type RealtimeClock = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type FlushScheduler = {
  /**
   * Ask for `flush` to run. Calls made while a flush is already pending are
   * absorbed into it, so the flush runs once per window however many events
   * arrived.
   */
  schedule: (flush: () => void) => void
  /** Drop a pending flush without running it. */
  cancel: () => void
}

export const systemClock: RealtimeClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A frame is `requestAnimationFrame` in a browser and a zero-delay timer
 * everywhere else, so the same code paces correctly under SSR and in tests.
 * An injected clock always wins — a test that supplies one is asking for its
 * timers to be the only ones.
 */
function frameClock(clock: RealtimeClock | undefined): RealtimeClock {
  if (clock) return clock
  if (typeof requestAnimationFrame !== 'function') return systemClock
  return {
    setTimeout: (fn) => requestAnimationFrame(fn),
    clearTimeout: (handle) => cancelAnimationFrame(handle as number),
  }
}

export function createFlushScheduler(
  mode: NotifyScheduler,
  clock?: RealtimeClock,
): FlushScheduler {
  if (mode === 'sync') {
    return { schedule: (flush) => flush(), cancel: () => {} }
  }

  const timers = mode === 'frame' ? frameClock(clock) : (clock ?? systemClock)
  const delayMs = mode === 'frame' ? 0 : Math.max(0, mode)
  let pending: unknown

  return {
    schedule(flush) {
      if (pending !== undefined) return
      pending = timers.setTimeout(() => {
        pending = undefined
        flush()
      }, delayMs)
    },
    cancel() {
      if (pending === undefined) return
      timers.clearTimeout(pending)
      pending = undefined
    },
  }
}
