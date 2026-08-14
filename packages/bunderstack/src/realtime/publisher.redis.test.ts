import { getEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'

import type { RealtimeChange } from './publisher'

import { createRedisRealtimePublisher } from './publisher'

const redisUrl = process.env.BUNDERSTACK_TEST_REDIS_URL

test.skipIf(!redisUrl)(
  'official Bun Redis publishers fan out and resume across instances',
  async () => {
    const commandA = new Bun.RedisClient(redisUrl!)
    const commandB = new Bun.RedisClient(redisUrl!)
    const subscriberA = commandA.duplicate()
    const subscriberB = commandB.duplicate()
    const prefix = `bunderstack:test:${crypto.randomUUID()}:`
    const publisherA = createRedisRealtimePublisher(commandA, subscriberA, {
      prefix,
      resumeSeconds: 60,
    })
    const publisherB = createRedisRealtimePublisher(commandB, subscriberB, {
      prefix,
      resumeSeconds: 60,
    })

    const change = (status: string): RealtimeChange => ({
      table: 'avatars',
      action: 'update',
      record: { id: 'a1', status },
    })

    try {
      let resolveFirst!: (value: RealtimeChange) => void
      const first = new Promise<RealtimeChange>((resolve) => {
        resolveFirst = resolve
      })
      const unsubscribe = await publisherB.subscribe('change', resolveFirst)
      await publisherA.publish('change', change('first'))
      const firstEvent = await first
      const firstId = getEventMeta(firstEvent)?.id
      expect(firstEvent.record.status).toBe('first')
      expect(firstId).toBeString()
      await unsubscribe()

      await publisherA.publish('change', change('second'))
      const resumed: RealtimeChange[] = []
      const unsubscribeResumed = await publisherB.subscribe(
        'change',
        (event) => resumed.push(event),
        { lastEventId: firstId },
      )
      expect(resumed.map((event) => event.record.status)).toEqual(['second'])
      await unsubscribeResumed()

      await publisherA.publish('change', change('after-unsubscribe'))
      await Bun.sleep(20)
      expect(resumed).toHaveLength(1)
    } finally {
      commandA.close()
      commandB.close()
      ;(await subscriberA).close()
      ;(await subscriberB).close()
    }
  },
)
