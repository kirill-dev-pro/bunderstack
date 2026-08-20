import { expect, test } from 'bun:test'

import { createFlushScheduler, type RealtimeClock } from './realtime-flush'

/** A clock whose timers only run when the test says so. */
function fakeClock(): RealtimeClock & { advance: () => void; pending: number } {
  const timers = new Map<number, () => void>()
  let nextId = 1
  return {
    setTimeout(fn) {
      const id = nextId++
      timers.set(id, fn)
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    get pending() {
      return timers.size
    },
    advance() {
      const due = [...timers.entries()]
      timers.clear()
      for (const [, fn] of due) fn()
    },
  }
}

test("'sync' runs the flush inline", () => {
  const scheduler = createFlushScheduler('sync')
  let flushes = 0

  scheduler.schedule(() => flushes++)

  expect(flushes).toBe(1)
})

test("'frame' coalesces many schedules into one flush", () => {
  const clock = fakeClock()
  const scheduler = createFlushScheduler('frame', clock)
  let flushes = 0
  const flush = () => flushes++

  scheduler.schedule(flush)
  scheduler.schedule(flush)
  scheduler.schedule(flush)
  expect(flushes).toBe(0)

  clock.advance()

  expect(flushes).toBe(1)
})

test("'frame' arms again after the pending flush has run", () => {
  const clock = fakeClock()
  const scheduler = createFlushScheduler('frame', clock)
  let flushes = 0
  const flush = () => flushes++

  scheduler.schedule(flush)
  clock.advance()
  scheduler.schedule(flush)
  clock.advance()

  expect(flushes).toBe(2)
})

test('a numeric mode debounces by that many milliseconds', () => {
  const delays: number[] = []
  const clock: RealtimeClock = {
    setTimeout(fn, ms) {
      delays.push(ms)
      fn()
      return 1
    },
    clearTimeout() {},
  }
  const scheduler = createFlushScheduler(120, clock)

  scheduler.schedule(() => {})

  expect(delays).toEqual([120])
})

test('cancel drops a pending flush without running it', () => {
  const clock = fakeClock()
  const scheduler = createFlushScheduler('frame', clock)
  let flushes = 0

  scheduler.schedule(() => flushes++)
  scheduler.cancel()
  clock.advance()

  expect(flushes).toBe(0)
  expect(clock.pending).toBe(0)
})

test('cancel lets a later schedule arm a fresh flush', () => {
  const clock = fakeClock()
  const scheduler = createFlushScheduler('frame', clock)
  let flushes = 0
  const flush = () => flushes++

  scheduler.schedule(flush)
  scheduler.cancel()
  scheduler.schedule(flush)
  clock.advance()

  expect(flushes).toBe(1)
})
