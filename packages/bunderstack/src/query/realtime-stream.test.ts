import { withEventMeta } from '@standardserver/core'
import { expect, test } from 'bun:test'

import type { RealtimeChange, RealtimeEvent } from './realtime-stream'

import { openRealtimeStream } from './realtime-stream'

/** Lets microtasks and the stream loop settle between clock moves. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A clock whose timers fire only when the test advances past their deadline. */
function fakeClock() {
  const timers = new Map<number, { at: number; fn: () => void }>()
  let now = 0
  let nextId = 1
  return {
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number)
    },
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
      await settle()
    },
  }
}

/** A stream the test feeds by hand, and that throws when its signal aborts. */
function controllable() {
  const queued: RealtimeEvent[] = []
  let wake: (() => void) | undefined

  return {
    push(event: RealtimeEvent) {
      queued.push(event)
      wake?.()
    },
    open(signal: AbortSignal): AsyncIterable<RealtimeEvent> {
      return (async function* () {
        for (;;) {
          if (signal.aborted) throw new Error('aborted')
          const next = queued.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          wake = undefined
        }
      })()
    },
  }
}

type Harness = ReturnType<typeof harness>

function harness(
  options: {
    livenessFactor?: number
    defaultKeepaliveMs?: number
  } = {},
) {
  const clock = fakeClock()
  const connections: Array<{
    lastEventId?: string
    stream: ReturnType<typeof controllable>
  }> = []
  const changes: RealtimeChange[] = []
  const errors: unknown[] = []
  const retries: Array<{ attempt: number; delayMs: number }> = []
  let reconnects = 0
  const controller = new AbortController()

  const handle = openRealtimeStream({
    subscribe: async ({ signal, lastEventId }) => {
      const stream = controllable()
      connections.push({ lastEventId, stream })
      return stream.open(signal)
    },
    onChange: (change) => changes.push(change),
    onReconnect: () => {
      reconnects++
    },
    onError: (error) => errors.push(error),
    onRetry: (retry) => retries.push(retry),
    signal: controller.signal,
    retryMs: 1000,
    clock,
    random: () => 0.5,
    ...options,
  })

  return {
    clock,
    connections,
    changes,
    errors,
    retries,
    handle,
    get reconnects() {
      return reconnects
    },
    latest: () => connections[connections.length - 1]!.stream,
    close: () => controller.abort(),
  }
}

/** Advance past the backoff delay so the next connection opens. */
async function reconnectAfterBackoff(h: Harness) {
  await h.clock.advance(1000)
}

test('silence past the liveness window aborts the attempt and reconnects', async () => {
  const h = harness()
  await settle()
  expect(h.connections.length).toBe(1)

  await h.clock.advance(12_500)
  await reconnectAfterBackoff(h)

  expect(h.connections.length).toBe(2)
  h.close()
})

test('a heartbeat re-arms the liveness timer', async () => {
  const h = harness()
  await settle()

  await h.clock.advance(10_000)
  h.latest().push({ type: 'heartbeat' })
  await settle()
  await h.clock.advance(10_000)

  expect(h.connections.length).toBe(1)
  h.close()
})

test('an absent intervalMs falls back to a five second keepalive', async () => {
  const h = harness()
  await settle()

  await h.clock.advance(12_000)
  expect(h.connections.length).toBe(1)

  await h.clock.advance(600)
  await reconnectAfterBackoff(h)

  expect(h.connections.length).toBe(2)
  h.close()
})

test('a server-advertised intervalMs overrides the default', async () => {
  const h = harness()
  await settle()

  h.latest().push({ type: 'heartbeat', intervalMs: 1000 })
  await settle()

  await h.clock.advance(3000)
  await reconnectAfterBackoff(h)

  expect(h.connections.length).toBe(2)
  h.close()
})

test('a liveness abort reports a retry but not an error', async () => {
  const h = harness()
  await settle()

  await h.clock.advance(12_500)
  await reconnectAfterBackoff(h)

  expect(h.errors).toEqual([])
  expect(h.retries.length).toBe(1)
  h.close()
})

test('lastEventId is carried across a reconnect', async () => {
  const h = harness()
  await settle()

  h.latest().push(
    withEventMeta(
      { table: 'cards', action: 'update', record: { id: 'c1' } },
      { id: 'evt-7' },
    ),
  )
  await settle()

  await h.clock.advance(12_500)
  await reconnectAfterBackoff(h)

  expect(h.connections[1]!.lastEventId).toBe('evt-7')
  h.close()
})

test('a reconnect notifies onReconnect, the first connection does not', async () => {
  const h = harness()
  await settle()
  expect(h.reconnects).toBe(0)

  await h.clock.advance(12_500)
  await reconnectAfterBackoff(h)

  expect(h.reconnects).toBe(1)
  h.close()
})

test('a throwing onChange reports the error and keeps the stream alive', async () => {
  const clock = fakeClock()
  const controller = new AbortController()
  const connections: number[] = []
  const errors: unknown[] = []
  const seen: RealtimeChange[] = []
  let stream!: ReturnType<typeof controllable>
  let first = true

  openRealtimeStream({
    subscribe: async ({ signal }) => {
      connections.push(1)
      stream = controllable()
      return stream.open(signal)
    },
    onChange: (change) => {
      if (first) {
        first = false
        throw new Error('listener blew up')
      }
      seen.push(change)
    },
    onReconnect: () => {},
    onError: (error) => errors.push(error),
    signal: controller.signal,
    clock,
    random: () => 0.5,
  })
  await settle()

  stream.push({ table: 'cards', action: 'update', record: { id: 'c1' } })
  await settle()
  stream.push({ table: 'cards', action: 'update', record: { id: 'c2' } })
  await settle()

  expect(errors.length).toBe(1)
  expect(seen.map((change) => change.record['id'])).toEqual(['c2'])
  expect(connections.length).toBe(1)
  controller.abort()
})

test('heartbeats are not reported as changes', async () => {
  const h = harness()
  await settle()

  h.latest().push({ type: 'heartbeat' })
  h.latest().push({ table: 'cards', action: 'create', record: { id: 'c1' } })
  await settle()

  expect(h.changes.map((change) => change.record['id'])).toEqual(['c1'])
  h.close()
})

test('closing the caller signal ends the loop without an error', async () => {
  const h = harness()
  await settle()

  h.close()
  await h.handle.done

  expect(h.errors).toEqual([])
  expect(h.connections.length).toBe(1)
})
