import { expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'

const backend = bunderstack({
  schema: {},
  database: { adapter: libsql() },
  api: (o) => ({
    explode: o.public
      .route({ method: 'GET', path: '/api/explode' })
      .handler(() => {
        throw new Error('fixture boom')
      }),
  }),
})

async function explode(fixture: Awaited<ReturnType<typeof backend.test>>) {
  return fixture.app.handler(new Request('http://bunderstack.test/api/explode'))
}

test('fixtures capture internal errors without writing to the console', async () => {
  const forwarded: unknown[][] = []
  const original = console.error
  console.error = (...args) => forwarded.push(args)
  try {
    await using fixture = await backend.test({
      database: { schema: 'push' },
    })
    expect((await explode(fixture)).status).toBe(500)
    expect(
      fixture.logs.errors.some((entry) =>
        entry.message.includes('fixture boom'),
      ),
    ).toBe(true)
    expect(forwarded).toEqual([])

    fixture.logs.clear()
    expect(fixture.logs.entries).toEqual([])
  } finally {
    console.error = original
  }
})

test('inherit captures and forwards while silent discards internal logs', async () => {
  const forwarded: unknown[][] = []
  const original = console.error
  console.error = (...args) => forwarded.push(args)
  try {
    await using inherited = await backend.test({
      logs: 'inherit',
      database: { schema: 'push' },
    })
    await explode(inherited)
    expect(inherited.logs.errors.length).toBeGreaterThan(0)
    expect(forwarded.length).toBeGreaterThan(0)

    forwarded.length = 0
    await using silent = await backend.test({
      logs: 'silent',
      database: { schema: 'push' },
    })
    await explode(silent)
    expect(silent.logs.entries).toEqual([])
    expect(forwarded).toEqual([])
  } finally {
    console.error = original
  }
})
