import { expect, test } from 'bun:test'

import { applyLiveFrame } from './apply'

type Row = { id: string; title: string }
const row = (id: string): Row => ({ id, title: id })

test('a snapshot replaces the view', () => {
  const rows = applyLiveFrame<Row>([row('x')], {
    type: 'snapshot',
    items: [row('a'), row('b')],
    sort: 'id',
    order: 'asc',
    limit: 100,
    hasMore: false,
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('an upsert inserts after its anchor', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('c')], {
    type: 'upsert',
    record: row('b'),
    afterId: 'a',
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b', 'c'])
})

test('a null anchor inserts at the head', () => {
  const rows = applyLiveFrame<Row>([row('b')], {
    type: 'upsert',
    record: row('a'),
    afterId: null,
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('an upsert of a held row moves it instead of duplicating it', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('b'), row('c')], {
    type: 'upsert',
    record: { id: 'a', title: 'moved' },
    afterId: 'c',
  })
  expect(rows.map((item) => item.id)).toEqual(['b', 'c', 'a'])
  expect(rows[2]!.title).toBe('moved')
})

test('an unknown anchor appends instead of jumping to the head', () => {
  const rows = applyLiveFrame<Row>([row('a')], {
    type: 'upsert',
    record: row('b'),
    afterId: 'gone',
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('rows the frame did not touch keep their identity', () => {
  const first = row('a')
  const rows = applyLiveFrame<Row>([first, row('c')], {
    type: 'upsert',
    record: row('b'),
    afterId: 'a',
  })
  expect(rows[0]).toBe(first)
})

test('a remove drops one row, and an unknown id is a no-op', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('b')], {
    type: 'remove',
    id: 'a',
  })
  expect(rows.map((item) => item.id)).toEqual(['b'])
  expect(applyLiveFrame<Row>(rows, { type: 'remove', id: 'z' })).toBe(rows)
})

test('a heartbeat keeps the same array reference', () => {
  const rows: readonly Row[] = [row('a')]
  expect(
    applyLiveFrame<Row>(rows, { type: 'heartbeat', intervalMs: 5000 }),
  ).toBe(rows)
})
