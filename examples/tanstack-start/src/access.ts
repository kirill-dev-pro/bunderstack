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
  },
  posts: {
    searchableColumns: ['title', 'body'],
    filterableColumns: ['replyToId', 'userId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  follows: {
    ownerColumn: 'followerId',
    list: 'public',
    get: 'public',
    create: 'authenticated',
    update: 'deny',
    delete: 'owner',
    filterableColumns: ['followerId', 'followingId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  likes: {
    ownerColumn: 'userId',
    list: 'public',
    get: 'public',
    create: 'authenticated',
    update: 'deny',
    delete: 'owner',
    filterableColumns: ['postId', 'userId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  retweets: {
    ownerColumn: 'userId',
    list: 'public',
    get: 'public',
    create: 'authenticated',
    update: 'deny',
    delete: 'owner',
    filterableColumns: ['postId', 'userId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  session: { crud: false },
  account: { crud: false },
  verification: { crud: false },
})
