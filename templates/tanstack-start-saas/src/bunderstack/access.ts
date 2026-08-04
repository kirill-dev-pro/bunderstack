import { defineAccess } from 'bunderstack/access'

import * as schema from './schema'

/**
 * Generated CRUD policy. Lists require a session and are scoped to the caller's
 * own rows; the browser can never widen that scope with a query parameter.
 * Auth and internal tables stay out of generated CRUD entirely.
 */
export const access = defineAccess(schema, {
  projects: {
    ownerColumn: 'ownerId',
    list: 'authenticated',
    get: 'owner',
    create: 'deny',
    update: 'owner',
    delete: 'owner',
    writableColumns: ['name', 'clientName', 'status', 'dueAt'],
    searchableColumns: ['name', 'clientName'],
    filterableColumns: ['status'],
    sortableColumns: ['createdAt', 'dueAt', 'name'],
    defaultSort: { column: 'createdAt', order: 'desc' },
    scope: {
      read: (ctx) => ({ ownerId: ctx.user?.id ?? '__none__' }),
      write: (ctx) => ({ ownerId: ctx.user?.id ?? '__none__' }),
    },
  },
  tasks: {
    ownerColumn: 'ownerId',
    list: 'authenticated',
    get: 'owner',
    create: 'deny',
    update: 'owner',
    delete: 'owner',
    writableColumns: ['title', 'status', 'position'],
    searchableColumns: ['title'],
    filterableColumns: ['projectId', 'status'],
    sortableColumns: ['position', 'createdAt'],
    defaultSort: { column: 'position', order: 'asc' },
    scope: {
      read: (ctx) => ({ ownerId: ctx.user?.id ?? '__none__' }),
      write: (ctx) => ({ ownerId: ctx.user?.id ?? '__none__' }),
    },
  },
  user: { crud: false },
  session: { crud: false },
  account: { crud: false },
  verification: { crud: false },
})
