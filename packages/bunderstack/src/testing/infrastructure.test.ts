import { expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { bunderstack, resend, telegram } from '../index'
import { bunderstackMessages } from '../internal-tables'

test('fixtures replace email storage and realtime infrastructure', async () => {
  const backend = bunderstack({
    schema: {},
    database: { adapter: libsql() },
    messaging: {
      email: resend({ from: 'App <app@test.local>' }),
      telegram: telegram(),
    },
    storage: {
      s3: true,
      defaultBucket: 'files',
      buckets: { files: { visibility: 'private' } },
    },
    realtime: { redis: 'redis://production.invalid:6379' },
  })

  await using t = await backend.test({ database: { schema: 'push' } })
  await t.app.messaging.email.send({
    to: 'a@test.local',
    subject: 'Hello',
    text: 'Body',
  })
  expect(t.messaging.email.sent).toEqual([
    expect.objectContaining({
      to: ['a@test.local'],
      subject: 'Hello',
      text: 'Body',
    }),
  ])
  await t.app.messaging.telegram.send({ to: 42, text: 'Telegram body' })
  expect(t.messaging.telegram.sent).toEqual([{ to: 42, text: 'Telegram body' }])
  expect(
    await (t.app.db as any).select().from(bunderstackMessages),
  ).toHaveLength(2)

  const bytes = new TextEncoder().encode('fixture-local')
  await t.app.storage.upload('files/a.txt', bytes, 'text/plain')
  expect(await t.storage.read('files/a.txt')).toEqual(bytes)
  expect(t.app.realtime.transport).toBe('memory')

  await using other = await backend.test({ database: { schema: 'push' } })
  expect(other.messaging.email.sent).toEqual([])
  expect(other.messaging.telegram.sent).toEqual([])
  await expect(other.storage.read('files/a.txt')).rejects.toThrow(/not found/i)
})
