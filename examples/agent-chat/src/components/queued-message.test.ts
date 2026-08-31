import { expect, test } from 'bun:test'

import { queueAction, type QueuedMessageState } from './queued-message'

const queued: QueuedMessageState = {
  clientMessageId: 'local-1',
  content: 'Next question',
  mode: 'after-current',
}

test('waits while a run is active and sends after a terminal update', () => {
  expect(queueAction(queued, 'running')).toEqual({ type: 'wait' })
  expect(queueAction(queued, 'complete')).toEqual({
    type: 'send',
    message: queued,
  })
})

test('interrupt requests stop until cancellation is confirmed', () => {
  const interrupt = {
    ...queued,
    content: 'Send now',
    mode: 'interrupt' as const,
  }

  expect(queueAction(interrupt, 'running')).toEqual({ type: 'stop' })
  expect(queueAction(interrupt, 'cancelling')).toEqual({ type: 'wait' })
  expect(queueAction(interrupt, 'cancelled')).toEqual({
    type: 'send',
    message: interrupt,
  })
})

test('a missing active run is safe to send after reload catch-up', () => {
  expect(queueAction(queued, undefined)).toEqual({
    type: 'send',
    message: queued,
  })
})
