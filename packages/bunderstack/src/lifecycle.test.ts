import { expect, test } from 'bun:test'

import { Lifecycle } from './lifecycle'

test('closes registered resources in reverse order exactly once', async () => {
  const closed: string[] = []
  const lifecycle = new Lifecycle()
  lifecycle.add(() => {
    closed.push('first')
  })
  lifecycle.add(async () => {
    closed.push('second')
  })

  const first = lifecycle.close()
  const second = lifecycle.close()
  expect(first).toBe(second)
  await first

  expect(closed).toEqual(['second', 'first'])
  expect(lifecycle.status).toBe('closed')
  expect(lifecycle.signal.aborted).toBe(true)
})

test('refuses new resources after closing begins', async () => {
  const lifecycle = new Lifecycle()
  await lifecycle.close()
  expect(() => lifecycle.add(() => {})).toThrow(/closed/)
})

test('runs every cleanup and aggregates synchronous and asynchronous failures', async () => {
  const closed: string[] = []
  const synchronousError = new Error('broker cleanup failed')
  const asynchronousError = new Error('queue cleanup failed')
  const lifecycle = new Lifecycle()

  lifecycle.add(() => {
    closed.push('database')
  })
  lifecycle.add(async () => {
    closed.push('queue')
    throw asynchronousError
  })
  lifecycle.add(() => {
    closed.push('broker')
    throw synchronousError
  })

  const error = await lifecycle.close().catch((reason: unknown) => reason)

  expect(closed).toEqual(['broker', 'queue', 'database'])
  expect(lifecycle.status).toBe('closed')
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([
    synchronousError,
    asynchronousError,
  ])
})
