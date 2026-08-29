/**
 * Type-level contract for the generated `list` input: `filters` and `sort` are
 * typed from the table's `access` entry, so a wrong column or a wrong value type
 * is a compile error rather than a runtime 400. `tsc --noEmit` on this package
 * is the assertion — every `@ts-expect-error` here fails the build the moment it
 * stops erroring.
 */
import type { InferRouterInputs } from '@orpc/server'

import { pgTable, integer, text } from 'drizzle-orm/pg-core'

import { pglite } from '../database/pglite'
import { bunderstack } from '../index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
  likes: integer('likes').notNull(),
})

const app = await bunderstack({
  schema: { posts },
  database: { adapter: pglite() },

  access: {
    posts: {
      crud: true,
      list: 'public',
      filterableColumns: ['userId', 'likes'],
      sortableColumns: ['id', 'likes'],
    },
  },
}).start({ env: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' } })

type Api = NonNullable<(typeof app)['$inferClient']>['api']
type ListInput = InferRouterInputs<Api>['posts']['list']

export const acceptsTypedFilters: ListInput = {
  filters: { userId: 'u1', likes: [1, 2] },
  limit: 10,
  sort: 'likes',
  order: 'desc',
  count: true,
}

export const acceptsNullFilter: ListInput = { filters: { userId: null } }

export const acceptsNullLiteralFromQuery: ListInput = {
  filters: { likes: 'null' },
}

export const acceptsEmptyFilters: ListInput = { filters: {} }

export const acceptsNoInput: ListInput = undefined

export const rejectsUnknownFilterColumn: ListInput = {
  // @ts-expect-error `title` is not in filterableColumns
  filters: { title: 'a' },
}

export const rejectsWrongFilterType: ListInput = {
  // @ts-expect-error `likes` is an integer column
  filters: { likes: 'many' },
}

// @ts-expect-error `title` is not in sortableColumns
export const rejectsUnsortableColumn: ListInput = { sort: 'title' }

// @ts-expect-error filters must be nested, not flat
export const rejectsFlatFilter: ListInput = { userId: 'u1' }
