import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { sanitizeWriteBody, validateAndResolveAccess } from './access'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
})
const schema = { posts }

function resolvedAccess(
  overrides: Parameters<typeof validateAndResolveAccess>[1] = {},
) {
  return validateAndResolveAccess(schema, {
    posts: {
      list: 'public',
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
      ...overrides?.posts,
    },
  }).get('posts')!
}

describe('sanitizeWriteBody', () => {
  it('create with no writableColumns passes id through', () => {
    const access = resolvedAccess()
    const out = sanitizeWriteBody(
      { id: 'x', title: 't' },
      access,
      'create',
      null,
    )
    expect(out.id).toBe('x')
    expect(out.title).toBe('t')
  })

  it('update strips id (id is immutable on update)', () => {
    const access = resolvedAccess()
    const out = sanitizeWriteBody(
      { id: 'x', title: 't' },
      access,
      'update',
      null,
    )
    expect(out.id).toBeUndefined()
    expect(out.title).toBe('t')
  })

  it('create with explicit writableColumns excluding id does not pass id through', () => {
    const access = resolvedAccess({
      posts: {
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
        writableColumns: ['title'],
      },
    })
    const out = sanitizeWriteBody(
      { id: 'x', title: 't' },
      access,
      'create',
      null,
    )
    expect(out.id).toBeUndefined()
    expect(out.title).toBe('t')
  })
})
