import { expect, test } from 'bun:test'

import { startJobWorker } from './runtime'

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

test('poll loop never overlaps ticks and closes gracefully', async () => {
  let active = 0
  let maxActive = 0
  const handle = startJobWorker({
    pollIntervalMs: 1,
    tick: async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 15))
  await handle.close()
  expect(maxActive).toBe(1)
})

test('a supplied signal stops the worker', async () => {
  const controller = new AbortController()
  const handle = startJobWorker({
    signal: controller.signal,
    pollIntervalMs: 100,
    tick: async () => {},
  })

  controller.abort()
  await handle.closed
  await expect(handle.close()).resolves.toBeUndefined()
})

test('task completion wakes the loop before the polling interval', async () => {
  const slot = deferred()
  const secondTick = deferred()
  let ticks = 0
  const handle = startJobWorker({
    pollIntervalMs: 60_000,
    tick: async () => {
      ticks++
      if (ticks === 1) return { wake: slot.promise }
      secondTick.resolve()
      return {}
    },
  })

  slot.resolve()
  await secondTick.promise
  expect(ticks).toBe(2)
  await handle.close()
})

test('close stops polling and waits for drain', async () => {
  const active = deferred()
  const enteredDrain = deferred()
  let drained = 0
  let closed = false
  const handle = startJobWorker({
    pollIntervalMs: 60_000,
    tick: async () => ({ wake: active.promise }),
    drain: async () => {
      drained++
      enteredDrain.resolve()
      await active.promise
    },
  })

  const closing = handle.close().then(() => {
    closed = true
  })
  await enteredDrain.promise
  expect(closed).toBe(false)
  expect(drained).toBe(1)

  active.resolve()
  await closing
  expect(closed).toBe(true)
  expect(drained).toBe(1)
})
