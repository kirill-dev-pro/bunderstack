import { defineAccess } from 'bunderstack/access'

import * as schema from './schema'

// Auth tables (user, session) are excluded from CRUD automatically —
// only domain tables need rules.
export const access = defineAccess(schema, {
  // Boards are capability URLs: the unguessable typeid IS the invite, so
  // `get` is public (anyone with the link opens the board) while `list`
  // stays off — "my boards" goes through the tRPC `myBoards` procedure so
  // nobody can enumerate other people's boards.
  boards: {
    ownerColumn: 'ownerId',
    list: 'deny',
    get: 'public',
    create: 'deny', // created via tRPC so ownerId is stamped server-side
    update: 'owner',
    delete: 'owner',
  },
  // Todos are fully collaborative: any signed-in visitor of a board can add,
  // toggle, and delete. No owner column — `crud: true` opts the table into
  // CRUD explicitly. Board pages list with `?boardId=` (filterable below).
  todos: {
    crud: true,
    list: 'authenticated',
    get: 'authenticated',
    create: 'authenticated',
    update: 'authenticated',
    delete: 'authenticated',
    filterableColumns: ['boardId'],
    searchableColumns: ['title'],
    sortableColumns: ['createdAt', 'done'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
})
