import { test, expect } from 'bun:test'

import { cronMatches, parseCron } from './cron'

// 2026-07-17 03:00:00 UTC, a Friday (getUTCDay() === 5).
const FRI_3AM = Date.UTC(2026, 6, 17, 3, 0)

test('every-minute wildcard matches any minute', () => {
  expect(cronMatches(parseCron('* * * * *'), FRI_3AM)).toBe(true)
  expect(cronMatches(parseCron('* * * * *'), FRI_3AM + 60_000)).toBe(true)
})

test('fixed daily time matches only that minute', () => {
  const daily = parseCron('0 3 * * *')
  expect(cronMatches(daily, FRI_3AM)).toBe(true)
  expect(cronMatches(daily, FRI_3AM + 60_000)).toBe(false)
  expect(cronMatches(daily, FRI_3AM + 60 * 60_000)).toBe(false)
})

test('step, range, and list fields', () => {
  const every5 = parseCron('*/5 * * * *')
  expect(cronMatches(every5, FRI_3AM)).toBe(true) // minute 0
  expect(cronMatches(every5, FRI_3AM + 5 * 60_000)).toBe(true)
  expect(cronMatches(every5, FRI_3AM + 3 * 60_000)).toBe(false)

  const business = parseCron('0 9-17 * * *')
  expect(cronMatches(business, Date.UTC(2026, 6, 17, 9, 0))).toBe(true)
  expect(cronMatches(business, Date.UTC(2026, 6, 17, 18, 0))).toBe(false)

  const list = parseCron('0,30 * * * *')
  expect(cronMatches(list, FRI_3AM + 30 * 60_000)).toBe(true)
  expect(cronMatches(list, FRI_3AM + 15 * 60_000)).toBe(false)
})

test('day-of-week matches and 7 aliases to Sunday', () => {
  expect(cronMatches(parseCron('0 3 * * 5'), FRI_3AM)).toBe(true) // Friday
  expect(cronMatches(parseCron('0 3 * * 1'), FRI_3AM)).toBe(false)
  const sun7 = parseCron('0 3 * * 7')
  const sunday = Date.UTC(2026, 6, 19, 3, 0) // 2026-07-19 is a Sunday
  expect(cronMatches(sun7, sunday)).toBe(true)
})

test('restricted dom OR dow (standard cron rule)', () => {
  // Friday the 17th: dom=1 doesn't match, dow=5 does → OR → match.
  expect(cronMatches(parseCron('0 3 1 * 5'), FRI_3AM)).toBe(true)
  // Neither matches → no match.
  expect(cronMatches(parseCron('0 3 1 * 1'), FRI_3AM)).toBe(false)
})

test('invalid expressions throw', () => {
  expect(() => parseCron('* * * *')).toThrow() // 4 fields
  expect(() => parseCron('60 * * * *')).toThrow() // minute out of range
  expect(() => parseCron('* 24 * * *')).toThrow() // hour out of range
  expect(() => parseCron('a * * * *')).toThrow()
  expect(() => parseCron('1-0 * * * *')).toThrow() // inverted range
})
