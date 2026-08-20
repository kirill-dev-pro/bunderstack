import { expect, test } from 'bun:test'

import type { RealtimeHeartbeat } from './heartbeat'

import { withRealtimeHeartbeat } from './heartbeat'

/** A source that stays idle long enough for a heartbeat to be emitted. */
function idle(): AsyncIterable<{ value: number }> {
  return (async function* () {
    await new Promise((resolve) => setTimeout(resolve, 200))
    yield { value: 1 }
  })()
}

function isHeartbeat(event: unknown): event is RealtimeHeartbeat {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as RealtimeHeartbeat).type === 'heartbeat'
  )
}

test('a heartbeat advertises the interval that produced it', async () => {
  const controller = new AbortController()
  const stream = withRealtimeHeartbeat(idle(), {
    intervalMs: 10,
    signal: controller.signal,
  })

  let beat: RealtimeHeartbeat | undefined
  for await (const event of stream) {
    if (isHeartbeat(event)) {
      beat = event
      break
    }
  }
  controller.abort()

  expect(beat).toEqual({ type: 'heartbeat', intervalMs: 10 })
})

test('the advertised interval reflects the default when none is given', async () => {
  const controller = new AbortController()
  const stream = withRealtimeHeartbeat(idle(), {
    intervalMs: 25,
    signal: controller.signal,
  })

  let beat: RealtimeHeartbeat | undefined
  for await (const event of stream) {
    if (isHeartbeat(event)) {
      beat = event
      break
    }
  }
  controller.abort()

  expect(beat?.intervalMs).toBe(25)
})
