import { expect, test } from 'bun:test'

import { startJobWorker } from './runtime'

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
