import type { Publisher } from '@orpc/publisher'

import { MemoryPublisher } from '@orpc/publisher/memory'

export type RealtimeAction = 'create' | 'update' | 'delete'

export interface RealtimeChange {
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
  /** Correlates this confirmed write with the client operation that caused it. */
  operationId?: string
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
