import { expect, test } from 'bun:test'

import { signScheduleRequest, verifyScheduleRequest } from './cron-auth'

test('signs and verifies the canonical task identifier and slot', () => {
  const signature = signScheduleRequest(
    'secret',
    'cron:hourly',
    1_721_307_600_000,
  )

  expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
  expect(
    verifyScheduleRequest(
      'secret',
      'cron:hourly',
      1_721_307_600_000,
      signature,
    ),
  ).toBe(true)
  expect(
    verifyScheduleRequest(
      'secret',
      'maintenance:hourly',
      1_721_307_600_000,
      signature,
    ),
  ).toBe(false)
})

test('rejects malformed signatures before comparing them', () => {
  expect(
    verifyScheduleRequest('secret', 'cron:hourly', 1_721_307_600_000, 'bad'),
  ).toBe(false)
})
