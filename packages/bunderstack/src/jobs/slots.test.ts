import { test, expect } from 'bun:test'

import { parseCron } from './cron'
import { floorSlot, slotsDue, SLOT_MS } from './slots'

const T = (iso: string) => Date.parse(iso)

test('floorSlot aligns down to the minute', () => {
  expect(floorSlot(T('2026-08-07T10:00:59.999Z'))).toBe(
    T('2026-08-07T10:00:00Z'),
  )
  expect(floorSlot(T('2026-08-07T10:00:00Z'))).toBe(T('2026-08-07T10:00:00Z'))
})

test('latest returns only the most recent matching slot', () => {
  const slots = slotsDue({
    cron: parseCron('*/5 * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:22:30Z'),
    catchUp: 'latest',
  })
  expect(slots).toEqual([T('2026-08-07T10:20:00Z')])
})

test('all returns every matching slot oldest first', () => {
  const slots = slotsDue({
    cron: parseCron('*/5 * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:22:30Z'),
    catchUp: 'all',
  })
  expect(slots).toEqual([
    T('2026-08-07T10:05:00Z'),
    T('2026-08-07T10:10:00Z'),
    T('2026-08-07T10:15:00Z'),
    T('2026-08-07T10:20:00Z'),
  ])
})

test('from is exclusive so a watermark slot is never re-emitted', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'all',
  })
  expect(slots).toEqual([])
})

test('all is clamped by catchUpWindowMs', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T00:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'all',
    catchUpWindowMs: 5 * SLOT_MS,
  })
  expect(slots).toEqual([
    T('2026-08-07T09:56:00Z'),
    T('2026-08-07T09:57:00Z'),
    T('2026-08-07T09:58:00Z'),
    T('2026-08-07T09:59:00Z'),
    T('2026-08-07T10:00:00Z'),
  ])
})

test('latest is clamped by catchUpWindowMs', () => {
  const slots = slotsDue({
    cron: parseCron('0 0 1 1 *'),
    from: T('2026-01-01T00:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'latest',
    catchUpWindowMs: 60 * SLOT_MS,
  })
  expect(slots).toEqual([])
})

test('every slot returned is minute aligned', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:03:41Z'),
    catchUp: 'all',
  })
  expect(slots.every((s) => s % SLOT_MS === 0)).toBe(true)
})

test('defaults to latest when catchUp is omitted', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:03:00Z'),
  })
  expect(slots).toEqual([T('2026-08-07T10:03:00Z')])
})
