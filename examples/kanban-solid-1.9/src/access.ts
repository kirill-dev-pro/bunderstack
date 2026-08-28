import { type AccessContext, defineAccess } from 'bunderstack/access'

import * as schema from './schema.ts'

/**
 * Every app row is scoped to the caller's active organization. A session with
 * no active org matches nothing rather than everything, so a member who has
 * not picked an org sees an empty board list instead of another org's rows.
 */
const orgScope = (ctx: AccessContext) => ({
  organizationId: ctx.session?.activeOrganizationId ?? '__none__',
})

const orgTable = {
  list: 'authenticated',
  get: 'authenticated',
  create: 'authenticated',
  update: 'authenticated',
  delete: 'authenticated',
  scope: { read: orgScope, write: orgScope },
} as const

export const access = defineAccess(schema, {
  boards: {
    ...orgTable,
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  lists: {
    ...orgTable,
    filterableColumns: ['boardId'],
    sortableColumns: ['position', 'id'],
    defaultSort: { column: 'position', order: 'asc' },
  },
  cards: {
    ...orgTable,
    filterableColumns: ['listId', 'boardId'],
    sortableColumns: ['position', 'id'],
    defaultSort: { column: 'position', order: 'asc' },
  },
  comments: {
    ...orgTable,
    ownerColumn: 'authorId',
    filterableColumns: ['cardId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'asc' },
  },
  // An audit trail: written by any member, never edited or removed.
  activity: {
    ...orgTable,
    update: 'deny',
    delete: 'deny',
    ownerColumn: 'actorId',
    filterableColumns: ['boardId', 'cardId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  user: { exposeAuthTable: true, list: 'authenticated', get: 'authenticated' },
  session: { crud: false },
  account: { crud: false },
  verification: { crud: false },
  organization: { crud: false },
  member: { crud: false },
  invitation: { crud: false },
})
