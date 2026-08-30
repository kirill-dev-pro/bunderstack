import { defineAccess, type AccessContext } from 'bunderstack/access'

import * as schema from './schema'

const ownRows = (ctx: AccessContext) => ({
  userId: ctx.user?.id ?? '__no_authenticated_user__',
})

const agentOwnedReadOnly = {
  crud: true,
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
  agentRunSteps: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'runId', 'visibility'],
    sortableColumns: ['sequence'],
    defaultSort: { column: 'sequence', order: 'asc' },
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
    sortableColumns: ['dueAt', 'createdAt'],
    defaultSort: { column: 'dueAt', order: 'asc' },
  },
  agentMemory: {
    ...agentOwnedReadOnly,
    filterableColumns: ['kind'],
    sortableColumns: ['updatedAt', 'createdAt'],
    defaultSort: { column: 'updatedAt', order: 'desc' },
  },
  agentInbox: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'status', 'delivery'],
    sortableColumns: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  agentRequests: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'status', 'kind'],
    sortableColumns: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  agentToolGrants: {
    ...agentOwnedReadOnly,
    filterableColumns: ['threadId', 'status', 'tool'],
    sortableColumns: ['grantedAt'],
    defaultSort: { column: 'grantedAt', order: 'desc' },
  },
  tasks: {
    ...agentOwnedReadOnly,
    searchableColumns: ['title'],
    sortableColumns: ['createdAt', 'done'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
})
