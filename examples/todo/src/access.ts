import { defineAccess } from 'bunderstack/access'

import * as schema from './schema'

// Auth tables (user, session) are excluded from CRUD automatically —
// only domain tables need rules.
export const access = defineAccess(schema, {
  todos: {
    ownerColumn: 'userId',
    // Lists are scoped per-user: everyone only ever sees their own rows
    // (applies to realtime events too).
    scope: (ctx) => ({ userId: ctx.user!.id }),
    list: 'authenticated',
    get: 'owner',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    searchableColumns: ['title'],
    sortableColumns: ['createdAt', 'done'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
})
