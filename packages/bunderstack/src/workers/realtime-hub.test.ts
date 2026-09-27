import { getEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'

import type { RealtimeChange } from '../realtime/publisher'

import { createFakeNamespace } from '../testing/workers-fakes'
import { HubPublisher, RealtimeHub } from './realtime-hub'
import { stub } from './types'

function setup(heartbeatMs = 20_000) {
  const namespace = createFakeNamespace((state) => {
    const hub = new RealtimeHub(state, {})
    hub.heartbeatMs = heartbeatMs
    return hub
  })
  return {
    namespace,
    publisher: () => new HubPublisher(() => stub(namespace, 'main')),
  }
}

const change = (id: string): RealtimeChange => ({
  table: 'notes',
  action: 'create',
  record: { id },
})

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(check()).toBe(true)
}

test('a publish from one publisher reaches a subscriber of another', async () => {
  const { publisher } = setup()
  const reader = publisher()
  const writer = publisher()
  const seen: RealtimeChange[] = []
  const unsubscribe = await reader.subscribe('change', (event) => {
    seen.push(event)
  })
  await writer.publish('change', change('n1'))
  await until(() => seen.length === 1)
  expect(seen[0]!.record).toEqual({ id: 'n1' })
  expect(getEventMeta(seen[0]!)?.id).toBeString()
  await unsubscribe()
})

test('a subscriber resumes after lastEventId', async () => {
  const { publisher } = setup()
  const p = publisher()
  const first: RealtimeChange[] = []
  const stop = await p.subscribe('change', (event) => {
    first.push(event)
  })
  await p.publish('change', change('a'))
  await p.publish('change', change('b'))
  await until(() => first.length === 2)
  await stop()
  const lastEventId = getEventMeta(first[0]!)!.id
  const resumed: RealtimeChange[] = []
  const stop2 = await p.subscribe(
    'change',
    (event) => {
      resumed.push(event)
    },
    { lastEventId },
  )
  await until(() => resumed.length === 1)
  expect(resumed[0]!.record).toEqual({ id: 'b' })
  await stop2()
})

test('the hub stream sends heartbeats', async () => {
  const { namespace } = setup(5)
  const res = await stub(namespace, 'main').fetch(
    'https://hub/subscribe?event=change',
  )
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  const { value } = await reader.read()
  expect(value).toContain('"type":"heartbeat"')
  await reader.cancel()
})
