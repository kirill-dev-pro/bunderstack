import type { Publisher } from '@orpc/publisher'
import type { RedisClient } from 'bun'

import { BunRedisPublisher } from '@orpc/bun'
import { MemoryPublisher } from '@orpc/publisher/memory'

export type RealtimeAction = 'create' | 'update' | 'delete'

export interface RealtimeChange {
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
}

export interface RealtimeEvents extends Record<string, object> {
  change: RealtimeChange
}

export type RealtimePublisher = Publisher<RealtimeEvents>

export interface RealtimePublisherOptions {
  maxBufferedEvents?: number
  resumeSeconds?: number
}

export function createMemoryRealtimePublisher(
  options: RealtimePublisherOptions = {},
): RealtimePublisher {
  return new MemoryPublisher<RealtimeEvents>({
    maxBufferedEvents: options.maxBufferedEvents,
    resume: { enabled: true, seconds: options.resumeSeconds ?? 300 },
  })
}

export function createRedisRealtimePublisher(
  redis: RedisClient,
  subscriber: RedisClient | Promise<RedisClient>,
  options: RealtimePublisherOptions & { prefix?: string } = {},
): RealtimePublisher {
  return new BunRedisPublisher<RealtimeEvents>(redis, {
    subscriber,
    prefix: options.prefix ?? 'bunderstack:',
    maxBufferedEvents: options.maxBufferedEvents,
    resume: { enabled: true, seconds: options.resumeSeconds ?? 300 },
  })
}
