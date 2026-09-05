import type { AnyDb } from '../dialect'
import type { BaseEnv } from '../env'
import type { MessagingConfig, MessagingFacades } from './types'

import { createMessaging as materialize } from './runtime'

/**
 * What a standalone messaging facade needs. `db` is the application's own
 * connection: pass it so captured and sent messages reach the same journal the
 * app writes, and omit it only when there is no database to write to.
 */
export type MessagingContext = {
  env: BaseEnv
  db?: AnyDb
}

/**
 * Builds channel facades outside a started app, for code that runs before or
 * beside it — a Better Auth builder sending an invitation, a script, a
 * one-off worker. Channels behave exactly as they do on `app.messaging`,
 * capture included.
 *
 * ```ts
 * export const auth = defineAuth(schema, ({ db, env }) => {
 *   const messaging = createMessaging({ email: resend({ from: env.EMAIL_FROM }) }, { env, db })
 *   return { …, sendInvitation: (to) => messaging.email.send({ to, … }) }
 * })
 * ```
 */
export function createMessaging<const TConfig extends MessagingConfig>(
  channels: TConfig,
  context: MessagingContext,
): MessagingFacades<TConfig> {
  return materialize(channels, { env: context.env, db: context.db })
}
