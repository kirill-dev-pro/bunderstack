import { expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { buildLiveInputSchema } from './list-input-schema'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  likes: integer('likes'),
})

const schema = buildLiveInputSchema(posts, {
  filterableColumns: ['userId'],
  sortableColumns: ['id', 'likes'],
})

test('a live input accepts limit, sort, order, and filters', () => {
  expect(
    v.parse(schema, {
      limit: 10,
      sort: 'likes',
      order: 'desc',
      filters: { userId: 'u1' },
    }),
  ).toEqual({
    limit: 10,
    sort: 'likes',
    order: 'desc',
    filters: { userId: 'u1' },
  })
})

test('a live input rejects what a stream cannot honor', () => {
  for (const input of [{ q: 'x' }, { offset: 10 }, { cursor: 'c' }]) {
    expect(() => v.parse(schema, input)).toThrow()
  }
})

test('a live input rejects a column that is not sortable', () => {
  expect(() => v.parse(schema, { sort: 'userId' })).toThrow()
})
