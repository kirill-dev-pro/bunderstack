import { expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'

test('fixtures replace email storage and realtime infrastructure', async () => {
  const backend = bunderstack({
    schema: {},
    database: { adapter: libsql() },
    email: { from: 'App <app@test.local>', provider: 'resend' },
    storage: {
      s3: true,
      defaultBucket: 'files',
      buckets: { files: { visibility: 'private' } },
    },
    realtime: { redis: 'redis://production.invalid:6379' },
  })

  await using t = await backend.test({ database: { schema: 'push' } })
  await t.app.email.send({
    to: 'a@test.local',
    subject: 'Hello',
    text: 'Body',
  })
  expect(t.email.sent).toEqual([
    expect.objectContaining({
      to: ['a@test.local'],
      subject: 'Hello',
      text: 'Body',
    }),
  ])

  const bytes = new TextEncoder().encode('fixture-local')
  await t.app.storage.upload('files/a.txt', bytes, 'text/plain')
  expect(await t.storage.read('files/a.txt')).toEqual(bytes)
  expect(t.app.realtime.transport).toBe('memory')

  await using other = await backend.test({ database: { schema: 'push' } })
  await expect(other.storage.read('files/a.txt')).rejects.toThrow(/not found/i)
})
