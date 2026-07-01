import { defineAccess } from 'bunderstack/access'

import * as schema from './schema'

/** Shared access rules for server (`bunderstack.ts`). */
export const access = defineAccess(schema, {
  user: {
    exposeAuthTable: true,
    ownerColumn: 'id',
    list: 'public',
    get: 'public',
    create: 'deny',
    update: 'owner',
    delete: 'deny',
    writableColumns: ['image', 'about'],
    searchableColumns: ['name', 'email', 'about'],
    filterableColumns: ['id'],
  },
  canvas: {
    ownerColumn: 'ownerId',
    list: 'authenticated',
    get: 'owner',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    filterableColumns: ['ownerId'],
    sortableColumns: ['updatedAt', 'createdAt', 'id'],
    scope: ({ user }) => ({ ownerId: user?.id ?? '' }),
  },
  shape: {
    crud: true,
    ownerColumn: 'ownerId',
    list: 'authenticated',
    get: 'owner',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    filterableColumns: ['canvasId', 'ownerId'],
    sortableColumns: ['createdAt', 'updatedAt', 'id'],
    scope: ({ user }) => ({ ownerId: user?.id ?? '' }),
  },
  session: { crud: false },
  account: { crud: false },
})
