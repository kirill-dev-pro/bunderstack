import { type } from 'arktype'
import { defineApi } from 'bunderstack'
import { asTypeId } from 'bunderstack/typeid'

import { getOrCreateThread, wakeAgent } from './agent/runtime'
import { resolveApproval, revokeToolGrant } from './agent/approvals'
import { deleteMemory, updateMemory } from './agent/memory'
import { envSchema } from './env'
import * as schema from './schema'

const o = defineApi({ schema, env: envSchema })

export const api = {
  sendMessage: o.protected
    .route({ method: 'POST', path: '/api/agent/messages', tags: ['agent'] })
    .input(
      type({
        content: '1 <= string <= 4000',
      }),
    )
    .output(
      type({
        messageId: 'string',
        threadId: 'string',
      }),
    )
    .handler(async ({ context, input }) => {
      const userId = asTypeId('user', context.user.id)
      const thread = await getOrCreateThread(context.db, userId)
      const [message] = await context.db
        .insert(schema.agentMessages)
        .values({
          threadId: thread.id,
          userId,
          role: 'user',
          content: input.content,
        })
        .returning()
      await context.realtime.publish(schema.agentMessages, 'create', message!)
      await wakeAgent(context, thread.id, 'message')
      return { messageId: message!.id, threadId: thread.id }
    }),
  updateMemory: o.protected
    .route({
      method: 'PATCH',
      path: '/api/agent/memory/{id}',
      tags: ['agent'],
    })
    .input(type({ id: 'string', value: 'unknown' }))
    .output(type({ id: 'string', status: "'updated'" }))
    .handler(async ({ context, input, errors }) => {
      const row = await updateMemory(context, {
        id: input.id,
        userId: context.user.id,
        value: input.value,
      })
      if (!row) throw errors.NOT_FOUND({ message: 'Memory not found' })
      return { id: row.id, status: 'updated' as const }
    }),
  deleteMemory: o.protected
    .route({
      method: 'DELETE',
      path: '/api/agent/memory/{id}',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(type({ id: 'string', status: "'deleted'" }))
    .handler(async ({ context, input, errors }) => {
      const deleted = await deleteMemory(context, {
        id: input.id,
        userId: context.user.id,
      })
      if (!deleted) throw errors.NOT_FOUND({ message: 'Memory not found' })
      return { id: input.id, status: 'deleted' as const }
    }),
  resolveApproval: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/approvals/{id}',
      tags: ['agent'],
    })
    .input(
      type({
        id: 'string',
        decision: "'allow_once' | 'always_allow' | 'reject'",
      }),
    )
    .output(
      type({
        status: "'executed' | 'rejected' | 'already_resolved'",
      }),
    )
    .handler(async ({ context, input, errors }) => {
      try {
        const result = await resolveApproval(context, {
          requestId: input.id,
          userId: context.user.id,
          decision: input.decision,
        })
        return { status: result.status }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Approval request not found'
        ) {
          throw errors.NOT_FOUND({ message: error.message })
        }
        throw error
      }
    }),
  revokeGrant: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/grants/{id}/revoke',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(type({ id: 'string', status: "'revoked'" }))
    .handler(async ({ context, input, errors }) => {
      const revoked = await revokeToolGrant(context, {
        grantId: input.id,
        userId: context.user.id,
      })
      if (!revoked) throw errors.NOT_FOUND({ message: 'Grant not found' })
      return { id: input.id, status: 'revoked' as const }
    }),
}
