import { expect, test } from 'bun:test'

import { startLocalCronScheduler } from './local-cron'

test('runs matching user cron slots once and stops cleanly', async () => {
  const slots: number[] = []
  let timer: (() => void) | undefined
  const scheduler = startLocalCronScheduler({
    cron: [{ name: 'hourly', schedule: '0 * * * *' }],
    now: () => Date.UTC(2026, 6, 18, 12, 0, 5),
    setTimer: (callback) => {
      timer = callback
      return 1 as never
    },
    clearTimer: () => {
      timer = undefined
    },
    runSlot: async (name, slot) => {
      expect(name).toBe('hourly')
      slots.push(slot)
    },
  })

  await scheduler.tick()
  expect(slots).toEqual([Date.UTC(2026, 6, 18, 12, 0)])
  expect(timer).toBeDefined()
  await scheduler.close()
  expect(timer).toBeUndefined()
})
