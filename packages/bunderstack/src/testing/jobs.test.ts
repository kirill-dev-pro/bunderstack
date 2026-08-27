import { expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { TestJobsConvergenceError, TestJobsError } from './jobs'

const database = { adapter: libsql() }
const testOptions = { database: { schema: 'push' as const } }

test('runUntilIdle drains immediate and recursively enqueued work', async () => {
  const ran: string[] = []
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        first: j.job({
          handler: async (_input, ctx) => {
            ran.push('first')
            await ctx.jobs.enqueue('second')
          },
        }),
        second: j.job({
          handler: () => {
            ran.push('second')
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('first')

  expect(await t.jobs.runUntilIdle()).toEqual({
    ticks: 2,
    claimed: 2,
    ran: 2,
    failed: 0,
    remainingRunnable: 0,
  })
  expect(ran).toEqual(['first', 'second'])
})

test('runNext only runs delayed work once the explicit clock reaches it', async () => {
  let calls = 0
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        delayed: j.job({
          handler: () => {
            calls++
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('delayed', undefined, { runAt: 2_000 })

  expect(await t.jobs.runNext({ now: 1_999 })).toMatchObject({
    ticks: 1,
    claimed: 0,
    remainingRunnable: 0,
  })
  expect(await t.jobs.runNext({ now: 2_000 })).toMatchObject({
    ticks: 1,
    claimed: 1,
    ran: 1,
    remainingRunnable: 0,
  })
  expect(calls).toBe(1)
})

test('runUntilIdle does not advance time to a scheduled retry', async () => {
  let calls = 0
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        retryLater: j.job({
          retries: 1,
          backoff: () => 1_000,
          handler: () => {
            calls++
            throw new Error('try later')
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('retryLater', undefined, { runAt: 5_000 })

  expect(await t.jobs.runUntilIdle({ now: 5_000 })).toEqual({
    ticks: 1,
    claimed: 1,
    ran: 0,
    failed: 1,
    remainingRunnable: 0,
  })
  expect(calls).toBe(1)

  expect(
    await t.jobs.runUntilIdle({ now: 6_000, failOnJobError: false }),
  ).toMatchObject({
    claimed: 1,
    ran: 0,
    failed: 1,
  })
  expect(calls).toBe(2)
})

test('terminal failures throw with queue-row details by default', async () => {
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        broken: j.job({
          retries: 0,
          handler: () => {
            throw new Error('permanent failure')
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('broken')

  try {
    await t.jobs.runUntilIdle()
    throw new Error('expected TestJobsError')
  } catch (error) {
    expect(error).toBeInstanceOf(TestJobsError)
    expect(error).toMatchObject({
      failures: [
        {
          name: 'broken',
          attempts: 1,
          lastError: 'permanent failure',
        },
      ],
    })
  }
})

test('terminal failures can be reported without throwing', async () => {
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        broken: j.job({
          retries: 0,
          handler: () => {
            throw new Error('expected')
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('broken')

  expect(
    await t.jobs.runUntilIdle({ failOnJobError: false }),
  ).toMatchObject({ ticks: 1, claimed: 1, failed: 1 })
})

test('runUntilIdle bounds recursive enqueue with a convergence error', async () => {
  const backend = bunderstack({
    schema: {},
    database,
    jobs: (j) =>
      j.define({
        again: j.job({
          handler: async (_input, ctx) => {
            await ctx.jobs.enqueue('again')
          },
        }),
      }),
  })

  await using t = await backend.test(testOptions)
  await t.app.jobs.enqueue('again')

  await expect(
    t.jobs.runUntilIdle({ maxTicks: 3 }),
  ).rejects.toMatchObject({
    name: 'TestJobsConvergenceError',
    report: {
      ticks: 3,
      claimed: 3,
      ran: 3,
      failed: 0,
      remainingRunnable: 1,
    },
  } satisfies Partial<TestJobsConvergenceError>)
})
