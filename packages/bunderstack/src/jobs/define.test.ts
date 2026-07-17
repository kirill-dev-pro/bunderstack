import { test, expect } from 'bun:test'
import { z } from 'zod'

import { backoffMs, createJobsBuilder, validateJobsDefs } from './define'

const j = createJobsBuilder<Record<string, never>>()

test('j.define returns the defs object unchanged and validated', () => {
  const defs = j.define({
    hello: j.job({
      input: z.object({ name: z.string() }),
      handler: async (input) => {
        // Type-level check: input is the parsed zod output.
        const _name: string = input.name
        void _name
      },
    }),
  })
  expect(Object.keys(defs)).toEqual(['hello'])
})

test('cron definitions cannot declare input', () => {
  expect(() =>
    validateJobsDefs({
      bad: {
        cron: '* * * * *',
        input: z.object({}),
        handler: async () => {},
      },
    }),
  ).toThrow(/cron/)
})

test('invalid cron expression throws at define time', () => {
  expect(() =>
    j.define({ bad: j.job({ cron: 'not a cron', handler: async () => {} }) }),
  ).toThrow(/invalid cron/)
})

test('negative retries and zero concurrency throw', () => {
  expect(() =>
    validateJobsDefs({ bad: { retries: -1, handler: async () => {} } }),
  ).toThrow(/retries/)
  expect(() =>
    validateJobsDefs({ bad: { concurrency: 0, handler: async () => {} } }),
  ).toThrow(/concurrency/)
})

test('backoffMs: default exponential, object form, function form', () => {
  const base = { handler: async () => {} }
  expect(backoffMs(base, 1)).toBe(1000)
  expect(backoffMs(base, 2)).toBe(2000)
  expect(backoffMs(base, 3)).toBe(4000)
  expect(backoffMs({ ...base, backoff: { baseMs: 100, factor: 3 } }, 2)).toBe(300)
  expect(backoffMs({ ...base, backoff: (a) => a * 7 }, 3)).toBe(21)
})
