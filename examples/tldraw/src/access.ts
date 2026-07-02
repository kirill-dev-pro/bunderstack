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
    // `get` is public so a board URL is a share link — anyone who has it can
    // open the board. No `scope`: it would also hide shared boards from
    // guests; the "Your canvases" page filters by ownerId instead.
    list: 'authenticated',
    get: 'public',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    filterableColumns: ['ownerId'],
    sortableColumns: ['updatedAt', 'createdAt', 'id'],
  },
  // Shared boards are guest-editable: anyone with the link can draw. No
  // owner scoping — every visitor sees every shape on the board.
  shape: {
    crud: true,
    list: 'public',
    get: 'public',
    create: 'public',
    update: 'public',
    delete: 'public',
    filterableColumns: ['canvasId', 'ownerId'],
    sortableColumns: ['createdAt', 'updatedAt', 'id'],
  },
  // Presence (live cursors, who's online) is an ordinary public table —
  // realtime broadcast-on-write does the rest.
  presence: {
    crud: true,
    list: 'public',
    get: 'public',
    create: 'public',
    update: 'public',
    delete: 'public',
    filterableColumns: ['canvasId'],
    sortableColumns: ['updatedAt', 'id'],
  },
  session: { crud: false },
  account: { crud: false },
})
