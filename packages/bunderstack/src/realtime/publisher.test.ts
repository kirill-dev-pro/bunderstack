import { getEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'

import { createMemoryRealtimePublisher } from './publisher'

const change = (status: string) => ({
  table: 'avatars',
  action: 'update' as const,
  record: { id: 'a1', status },
})

test('publishes typed changes and resumes after lastEventId', async () => {
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const live = publisher.subscribe('change')

  await publisher.publish('change', change('first'))
  const first = await live.next()
  const firstId = getEventMeta(first.value)?.id
  expect(firstId).toBeString()

  await publisher.publish('change', change('second'))
  const resumed = publisher.subscribe('change', { lastEventId: firstId })
  expect((await resumed.next()).value).toMatchObject({
    record: { status: 'second' },
  })

  await live.return?.()
  await resumed.return?.()
})

test('bounds slow-consumer buffering and aborts subscriptions', async () => {
  const publisher = createMemoryRealtimePublisher({ maxBufferedEvents: 2 })
  const controller = new AbortController()
  const changes = publisher.subscribe('change', {
    signal: controller.signal,
  })

  await publisher.publish('change', change('first'))
  await publisher.publish('change', change('second'))
  await publisher.publish('change', change('third'))

  expect((await changes.next()).value).toMatchObject({
    record: { status: 'second' },
  })
  expect((await changes.next()).value).toMatchObject({
    record: { status: 'third' },
  })

  controller.abort(new Error('closed'))
  await expect(changes.next()).rejects.toThrow('closed')
})

test('does not replay expired events', async () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const publisher = createMemoryRealtimePublisher({ resumeSeconds: 1 })
    const live = publisher.subscribe('change')
    await publisher.publish('change', change('first'))
    const firstId = getEventMeta((await live.next()).value)?.id
    await live.return?.()

    now = 3_000
    const replayed: string[] = []
    const unsubscribe = await publisher.subscribe(
      'change',
      (event) => replayed.push(event.record.status as string),
      { lastEventId: firstId },
    )
    expect(replayed).toEqual([])
    await unsubscribe()
  } finally {
    Date.now = originalNow
  }
})
