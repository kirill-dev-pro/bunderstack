import { expect, test } from 'bun:test'

import { mergeRevisionedMessage, nextTextFrame } from './streaming-text'

test('an older realtime snapshot cannot roll streamed text back', () => {
  const current = { id: 'amsg_one', content: 'A durable answer', revision: 4 }

  expect(
    mergeRevisionedMessage(current, {
      id: 'amsg_one',
      content: 'A durable',
      revision: 3,
    }),
  ).toBe(current)
})

test('a newer snapshot replaces the canonical target', () => {
  expect(
    mergeRevisionedMessage(
      { id: 'amsg_one', content: 'Old draft', revision: 2 },
      { id: 'amsg_one', content: 'Fresh answer', revision: 3 },
    ),
  ).toEqual({ id: 'amsg_one', content: 'Fresh answer', revision: 3 })
})

test('a text frame advances smoothly through an appended snapshot', () => {
  expect(nextTextFrame('Hello', 'Hello durable world', 4)).toBe('Hello dur')
})

test('a rewritten snapshot is shown immediately instead of animating stale text', () => {
  expect(nextTextFrame('Old draft', 'Fresh answer', 4)).toBe('Fresh answer')
})
