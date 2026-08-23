import { expect, test } from 'bun:test'

import type { RealtimeChange } from '../realtime/publisher'

import { createLiveWindow, type LiveWindowOptions } from './live-window'

const row = (id: string, rank: number, userId = 'u1') => ({ id, rank, userId })

const change = (
  action: RealtimeChange['action'],
  record: Record<string, unknown>,
): RealtimeChange => ({ table: 'posts', action, record })

function windowOf(
  items: Record<string, unknown>[],
  hasMore: boolean,
  options: Partial<LiveWindowOptions> = {},
) {
  const view = createLiveWindow({
    sort: 'rank',
    order: 'asc',
    limit: 3,
    ...options,
  })
  view.reset(items, hasMore)
  return view
}

test('a new row lands after its predecessor', () => {
  const view = windowOf([row('a', 1), row('c', 3)], false)
  expect(view.apply(change('create', row('b', 2)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 2), afterId: 'a' }],
  })
})

test('a new head row reports a null anchor', () => {
  const view = windowOf([row('b', 2)], false)
  expect(view.apply(change('create', row('a', 1)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('a', 1), afterId: null }],
  })
})

test('an update that moves a row re-anchors it', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], false)
  expect(view.apply(change('update', row('a', 9)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('a', 9), afterId: 'c' }],
  })
})

test('rows with an equal sort key break the tie by id, as SQL does', () => {
  const view = windowOf([row('a', 1), row('c', 1)], false)
  expect(view.apply(change('create', row('b', 1)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 1), afterId: 'a' }],
  })
})

test('descending order inverts both keys', () => {
  const view = windowOf([row('c', 3), row('a', 1)], false, { order: 'desc' })
  expect(view.apply(change('create', row('b', 2)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 2), afterId: 'c' }],
  })
})

test('a full window evicts its last row', () => {
  const view = windowOf([row('b', 2), row('c', 3), row('d', 4)], false)
  expect(view.apply(change('create', row('a', 1)))).toEqual({
    type: 'frames',
    frames: [
      { type: 'upsert', record: row('a', 1), afterId: null },
      { type: 'remove', id: 'd' },
    ],
  })
})

test('a row that sorts below a full window is ignored', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], true)
  expect(view.apply(change('create', row('z', 9)))).toEqual({ type: 'none' })
})

test('a delete inside a complete view removes the row', () => {
  const view = windowOf([row('a', 1), row('b', 2)], false)
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'frames',
    frames: [{ type: 'remove', id: 'a' }],
  })
})

test('a delete inside a truncated view asks for a fresh snapshot', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], true)
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'resnapshot',
  })
})

test('a delete outside the view says nothing', () => {
  const view = windowOf([row('a', 1)], true)
  expect(view.apply(change('delete', row('z', 9)))).toEqual({ type: 'none' })
})

test('an update that leaves the filters removes the row', () => {
  const view = windowOf([row('a', 1), row('b', 2)], false, {
    filters: { userId: 'u1' },
  })
  expect(view.apply(change('update', row('a', 1, 'u2')))).toEqual({
    type: 'frames',
    frames: [{ type: 'remove', id: 'a' }],
  })
})

test('a create that never matched the filters says nothing', () => {
  const view = windowOf([row('a', 1)], false, { filters: { userId: 'u1' } })
  expect(view.apply(change('create', row('z', 9, 'u2')))).toEqual({
    type: 'none',
  })
})

test('a row that moves out of a complete window is removed', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], false)
  expect(view.apply(change('update', row('a', 9)))).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('a', 9), afterId: 'c' }],
  })
})

test('an eviction marks the view truncated', () => {
  const view = windowOf([row('b', 2), row('c', 3), row('d', 4)], false)
  view.apply(change('create', row('a', 1)))
  // 'd' now sits below the window, so the next removal needs a re-query.
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'resnapshot',
  })
})

test('reset adopts a new query result', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], true)
  view.reset([row('b', 2)], false)
  expect(view.apply(change('delete', row('b', 2)))).toEqual({
    type: 'frames',
    frames: [{ type: 'remove', id: 'b' }],
  })
})
