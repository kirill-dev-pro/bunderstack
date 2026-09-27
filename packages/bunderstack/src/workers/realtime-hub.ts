// src/workers/realtime-hub.ts — realtime fan-out for one app. The hub holds a
// MemoryPublisher with resume; Workers reach it over a line-delimited stream.
// Payloads cross as oRPC's RPC JSON, as with the Redis publisher, so Date and
// BigInt values survive; the hub itself never looks inside them.
import type {
  PublisherOptions,
  PublisherSubscribeListenerOptions,
} from '@orpc/publisher'

import { RPCJsonSerializer } from '@orpc/client'
import { Publisher } from '@orpc/publisher'
import { MemoryPublisher } from '@orpc/publisher/memory'
import { getEventMeta, withEventMeta } from '@orpc/server'

import type { RealtimeEvents } from '../realtime/publisher'
import type { DurableObjectStateLike, FetcherLike } from './types'

type HubLine =
  | { type: 'event'; id?: string; payload: object }
  | { type: 'heartbeat' }

export class RealtimeHub {
  /** celld closes a stream after 60 s of silence. */
  heartbeatMs = 20_000
  private readonly publisher = new MemoryPublisher<Record<string, object>>({
    resume: { enabled: true, seconds: 300 },
  })

  constructor(_state: DurableObjectStateLike, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      const { event, payload } = (await request.json()) as {
        event: string
        payload: object
      }
      await this.publisher.publish(event, payload)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/subscribe')
      return this.subscribe(url, request.signal)
    return new Response('Not found', { status: 404 })
  }

  private async subscribe(url: URL, signal: AbortSignal): Promise<Response> {
    const event = url.searchParams.get('event') ?? 'change'
    const lastEventId = url.searchParams.get('lastEventId') ?? undefined
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    let closed = false
    let timer: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => Promise<void>) | undefined
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      void unsubscribe?.()
      void writer.close().catch(() => {})
    }
    const write = (line: HubLine) => {
      if (closed) return
      writer.write(encoder.encode(`${JSON.stringify(line)}\n`)).catch(close)
    }
    unsubscribe = await this.publisher.subscribe(
      event,
      (payload) =>
        write({ type: 'event', id: getEventMeta(payload)?.id, payload }),
      { lastEventId },
    )
    timer = setInterval(() => write({ type: 'heartbeat' }), this.heartbeatMs)
    signal?.addEventListener('abort', close)
    return new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  }
}

export class HubPublisher extends Publisher<RealtimeEvents> {
  constructor(
    private readonly hub: () => FetcherLike,
    options?: PublisherOptions,
  ) {
    super(options)
  }

  private readonly serializer = new RPCJsonSerializer()

  async publish<K extends keyof RealtimeEvents & string>(
    event: K,
    payload: RealtimeEvents[K],
  ): Promise<void> {
    const res = await this.hub().fetch('https://hub/publish', {
      method: 'POST',
      body: JSON.stringify({
        event,
        payload: this.serializer.serialize(payload),
      }),
    })
    if (!res.ok) {
      throw new Error(
        `[bunderstack] realtime hub publish failed (${res.status})`,
      )
    }
  }

  protected async subscribeListener<K extends keyof RealtimeEvents & string>(
    event: K,
    listener: (payload: RealtimeEvents[K]) => void,
    options?: PublisherSubscribeListenerOptions,
  ): Promise<() => Promise<void>> {
    const url = new URL('https://hub/subscribe')
    url.searchParams.set('event', event)
    if (options?.lastEventId) {
      url.searchParams.set('lastEventId', options.lastEventId)
    }
    const controller = new AbortController()
    const res = await this.hub().fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new Error(
        `[bunderstack] realtime hub subscribe failed (${res.status})`,
      )
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    void (async () => {
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += value
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const text = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (!text) continue
            const line = JSON.parse(text) as HubLine
            if (line.type !== 'event') continue
            const payload = this.serializer.deserialize(
              line.payload as Parameters<RPCJsonSerializer['deserialize']>[0],
            ) as RealtimeEvents[K]
            listener(
              line.id ? withEventMeta(payload, { id: line.id }) : payload,
            )
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) options?.onError?.(error as Error)
      }
    })()
    return async () => {
      controller.abort()
      await reader.cancel().catch(() => {})
    }
  }
}
