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
