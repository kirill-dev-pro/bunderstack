import { expect, test } from 'bun:test'

import { applyFrame, type Todo, type ViewMeta } from './todos'

const meta: ViewMeta = { sort: 'createdAt', order: 'desc', limit: 100 }

const todo = (id: string, done: boolean): Todo => ({
  id,
  title: `t${id}`,
  done,
  // Distinct days, so id order == createdAt order.
  createdAt: new Date(2026, 0, Number(id)).toISOString(),
})

test('snapshot replaces the view wholesale', () => {
  const rows = applyFrame([], { type: 'snapshot', items: [todo('2', false), todo('1', false)], ...meta }, meta)
  expect(rows.map((row) => row.id)).toEqual(['2', '1'])
})

test('upsert replaces its own row instead of duplicating it', () => {
  let rows = applyFrame([], { type: 'snapshot', items: [todo('2', false), todo('1', false)], ...meta }, meta)
  rows = applyFrame(rows, { type: 'upsert', record: todo('1', true) }, meta)
  // Row 1 keeps its sorted position (its createdAt did not change).
  expect(rows.map((row) => `${row.id}:${row.done}`)).toEqual(['2:false', '1:true'])
  // …and back.
  rows = applyFrame(rows, { type: 'upsert', record: todo('1', false) }, meta)
  expect(rows.map((row) => `${row.id}:${row.done}`)).toEqual(['2:false', '1:false'])
})

test('a fresh create lands on top under createdAt desc', () => {
  let rows = applyFrame([], { type: 'snapshot', items: [todo('3', false)], ...meta }, meta)
  rows = applyFrame(rows, { type: 'upsert', record: todo('9', false) }, meta)
  expect(rows.map((row) => row.id)).toEqual(['9', '3'])
})

test('remove drops only the named row', () => {
  let rows = applyFrame([], { type: 'snapshot', items: [todo('2', false), todo('1', false)], ...meta }, meta)
  rows = applyFrame(rows, { type: 'remove', id: '1' }, meta)
  expect(rows.map((row) => row.id)).toEqual(['2'])
})

test('limit trims the tail of the sorted view', () => {
  let rows = applyFrame([], { type: 'snapshot', items: [todo('5', false), todo('4', false)], limit: 2, sort: 'createdAt', order: 'desc' }, { ...meta, limit: 2 })
  rows = applyFrame(rows, { type: 'upsert', record: todo('6', false) }, { ...meta, limit: 2 })
  expect(rows.map((row) => row.id)).toEqual(['6', '5'])
})
