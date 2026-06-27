import { defineAccess, type AccessContext } from 'bunderstack/access'
import * as schema from './schema'

const orgScope = (ctx: AccessContext) => ({
  organizationId: ctx.session?.activeOrganizationId ?? '__none__',
})

const orgTable = {
  list: 'authenticated',
  get: 'authenticated',
  create: 'authenticated',
  update: 'authenticated',
  delete: 'authenticated',
  scope: orgScope,
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
  activity: {
    ...orgTable,
    create: 'authenticated',
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
