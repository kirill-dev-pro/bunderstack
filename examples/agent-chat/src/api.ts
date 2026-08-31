import { type } from 'arktype'
import { defineApi } from 'bunderstack'
import { asTypeId } from 'bunderstack/typeid'

import { resolveApproval, revokeToolGrant } from './agent/approvals'
import {
  cancelCommitment,
  pauseCommitment,
  resumeCommitment,
} from './agent/commitments'
import { requestRunCancellation } from './agent/cancellation'
import { deleteMemory, updateMemory } from './agent/memory'
import {
  acceptUserMessage,
  ActiveUserMessageRunError,
} from './agent/messages'
import { envSchema } from './env'
import * as schema from './schema'

const o = defineApi({ schema, env: envSchema })

export const api = {
  sendMessage: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/messages',
      tags: ['agent'],
      successStatus: 202,
    })
    .input(
      type({
        content: '1 <= string <= 4000',
        clientMessageId: '1 <= string <= 128',
      }),
    )
    .output(
      type({
        messageId: 'string',
        threadId: 'string',
        runId: 'string',
        assistantMessageId: 'string',
      }),
    )
    .handler(async ({ context, input, errors }) => {
      const userId = asTypeId('user', context.user.id)
      try {
        return await acceptUserMessage(context, { ...input, userId })
      } catch (error) {
        if (error instanceof ActiveUserMessageRunError) {
          throw errors.CONFLICT({ message: error.message })
        }
        throw error
      }
    }),
  stopRun: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/runs/{id}/stop',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(
      type({
        id: 'string',
        status: "'cancelling' | 'cancelled' | 'complete' | 'error'",
      }),
    )
    .handler(async ({ context, input, errors }) => {
      const run = await requestRunCancellation(context, {
        runId: input.id,
        userId: context.user.id,
      })
      if (!run) throw errors.NOT_FOUND({ message: 'Agent run not found' })
      if (
        run.status !== 'cancelling' &&
        run.status !== 'cancelled' &&
        run.status !== 'complete' &&
        run.status !== 'error'
      ) {
        throw errors.CONFLICT({ message: 'Agent run could not be stopped' })
      }
      return { id: run.id, status: run.status }
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
        status: "'resuming' | 'rejected' | 'already_resolved'",
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
  pauseCommitment: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/commitments/{id}/pause',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(type({ id: 'string', status: "'paused'" }))
    .handler(async ({ context, input, errors }) => {
      try {
        const commitment = await pauseCommitment(context, {
          commitmentId: input.id,
          userId: context.user.id,
        })
        return { id: commitment.id, status: 'paused' as const }
      } catch (error) {
        throw errors.NOT_FOUND({
          message:
            error instanceof Error ? error.message : 'Commitment not found',
        })
      }
    }),
  resumeCommitment: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/commitments/{id}/resume',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(type({ id: 'string', status: "'pending'" }))
    .handler(async ({ context, input, errors }) => {
      try {
        const commitment = await resumeCommitment(context, {
          commitmentId: input.id,
          userId: context.user.id,
        })
        return { id: commitment.id, status: 'pending' as const }
      } catch (error) {
        throw errors.NOT_FOUND({
          message:
            error instanceof Error ? error.message : 'Commitment not found',
        })
      }
    }),
  cancelCommitment: o.protected
    .route({
      method: 'POST',
      path: '/api/agent/commitments/{id}/cancel',
      tags: ['agent'],
    })
    .input(type({ id: 'string' }))
    .output(type({ id: 'string', status: "'cancelled'" }))
    .handler(async ({ context, input, errors }) => {
      try {
        const commitment = await cancelCommitment(context, {
          commitmentId: input.id,
          userId: context.user.id,
        })
        return { id: commitment.id, status: 'cancelled' as const }
      } catch (error) {
        throw errors.NOT_FOUND({
          message:
            error instanceof Error ? error.message : 'Commitment not found',
        })
      }
    }),
}
