import { defineAccess, type AccessContext } from 'bunderstack/access'

import * as schema from './schema'

const ownRows = (ctx: AccessContext) => ({
  userId: ctx.user?.id ?? '__no_authenticated_user__',
})

const agentOwnedReadOnly = {
  list: 'authenticated',
  get: 'authenticated',
  create: 'deny',
  update: 'deny',
  delete: 'deny',
  scope: { read: ownRows },
} as const

export const access = defineAccess(schema, {
  agentThreads: {
    ...agentOwnedReadOnly,
    sortableColumns: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  agentMessages: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId'],
    sortableColumns: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'asc' },
  },
  agentRuns: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId'],
    sortableColumns: ['startedAt'],
    defaultSort: { column: 'startedAt', order: 'desc' },
  },
  agentToolCalls: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'runId'],
    sortableColumns: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  agentCommitments: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'status'],
    sortableColumns: ['dueAt'],
    defaultSort: { column: 'dueAt', order: 'asc' },
  },
  tasks: {
    ...agentOwnedReadOnly,
    searchableColumns: ['title'],
    sortableColumns: ['createdAt', 'done'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
})
