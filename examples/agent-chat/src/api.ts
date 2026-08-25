import { type } from 'arktype'
import { defineApi } from 'bunderstack'
import { asTypeId } from 'bunderstack/typeid'

import { getOrCreateThread, wakeAgent } from './agent/runtime'
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
}
