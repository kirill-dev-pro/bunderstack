import { test, expect } from 'bun:test'
import * as v from 'valibot'

import {
  backoffMs,
  createJobsBuilder,
  validateBackgroundDefs,
  validateJobsDefs,
} from './define'
import { CRON_PREFIX } from './slots'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

const j = createJobsBuilder<Record<string, never>>()

test('j.define returns the defs object unchanged and validated', () => {
  const defs = j.define({
    hello: j.job({
      input: v.object({ name: v.string() }),
      handler: async (input) => {
        // Type-level check: input is the parsed Standard Schema output.
        const _name: string = input.name
        void _name
      },
    }),
  })
  expect(Object.keys(defs)).toEqual(['hello'])
})

test('j.job and j.cron produce discriminated definitions', () => {
  const defs = j.define({
    email: j.job({
      input: v.object({ to: v.string() }),
      handler: async () => {},
    }),
    hourly: j.cron({
      schedule: '0 * * * *',
      handler: async () => {},
    }),
  })

  expect(defs.email.kind).toBe('job')
  expect(defs.hourly.kind).toBe('cron')
  expect(defs.hourly.schedule).toBe('0 * * * *')

  type _schedule = Expect<
    Equal<(typeof defs)['hourly']['schedule'], '0 * * * *'>
  >
})

test('cron rejects invalid expressions', () => {
  expect(() =>
    j.cron({ schedule: 'not cron', handler: async () => {} }),
  ).toThrow(/invalid cron/)
})

test('negative retries and zero concurrency throw', () => {
  expect(() =>
    validateJobsDefs({
      bad: { kind: 'job', retries: -1, handler: async () => {} },
    }),
  ).toThrow(/retries/)
  expect(() =>
    validateJobsDefs({
      bad: { kind: 'job', concurrency: 0, handler: async () => {} },
    }),
  ).toThrow(/concurrency/)
})

test('backoffMs: default exponential, object form, function form', () => {
  const base = { kind: 'job' as const, handler: async () => {} }
  const b1 = backoffMs(base, 1)
  expect(b1).toBeGreaterThanOrEqual(800)
  expect(b1).toBeLessThanOrEqual(1200)
  const b2 = backoffMs({ ...base, backoff: { baseMs: 100, factor: 3 } }, 2)
  expect(b2).toBeGreaterThanOrEqual(240)
  expect(b2).toBeLessThanOrEqual(360)
  expect(backoffMs({ ...base, backoff: (a) => a * 7 }, 3)).toBe(21)
})

test('cron definitions accept retry options', () => {
  const j = createJobsBuilder()
  const def = j.cron({
    schedule: '* * * * *',
    retries: 5,
    timeout: 30_000,
    catchUp: 'all',
    catchUpWindow: 120_000,
    handler: () => {},
    onFailed: () => {},
  })
  expect(def.kind).toBe('cron')
  expect(def.retries).toBe(5)
  expect(def.timeout).toBe(30_000)
  expect(def.catchUp).toBe('all')
})

test('cron rejects concurrency', () => {
  expect(() =>
    validateBackgroundDefs({
      nightly: {
        kind: 'cron',
        schedule: '0 0 * * *',
        concurrency: 2,
        handler: () => {},
      } as never,
    }),
  ).toThrow(/concurrency is not supported for cron/)
})

test('cron validates retries and timeout like jobs', () => {
  expect(() =>
    validateBackgroundDefs({
      a: {
        kind: 'cron',
        schedule: '* * * * *',
        retries: -1,
        handler: () => {},
      },
    }),
  ).toThrow(/retries must be a non-negative integer/)
  expect(() =>
    validateBackgroundDefs({
      b: { kind: 'cron', schedule: '* * * * *', timeout: 0, handler: () => {} },
    }),
  ).toThrow(/timeout must be positive/)
})

test('queue job names may not use the reserved cron prefix', () => {
  expect(() =>
    validateBackgroundDefs({
      [`${CRON_PREFIX}sneaky`]: { kind: 'job', handler: () => {} },
    }),
  ).toThrow(/reserved/)
})

test('backoffMs applies jitter within the expected band', () => {
  const def = { kind: 'job', handler: () => {} } as never
  const samples = Array.from({ length: 50 }, () => backoffMs(def, 1))
  // base 1000ms, +/-20% jitter
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(800)
  expect(Math.max(...samples)).toBeLessThanOrEqual(1200)
  expect(new Set(samples).size).toBeGreaterThan(1)
})
