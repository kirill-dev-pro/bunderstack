// Type-only checks for the documented way to get exact channel types inside a
// builder declared in its own module. tsc is the assertion runner here.
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { EmailMessage } from '../email'
import type { BunderstackJobsBuilder } from '../jobs'
import type { ResendDescriptor } from './email'
import type { TelegramDescriptor, TelegramMessage } from './telegram'

import { defineApi } from '../api/builder'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const schema = { notes }
const envSchema = { server: { TOKEN: v.optional(v.string()) } }

type Channels = { email: ResendDescriptor; ops: TelegramDescriptor }
declare const channels: Channels

// `defineApi` carries the channel record into the procedure context.
const o = defineApi({ schema, env: envSchema, messaging: channels })
const ping = o.public.handler(async ({ context }) => {
  type EmailInput = Parameters<typeof context.messaging.email.send>[0]
  type TelegramInput = Parameters<typeof context.messaging.ops.send>[0]
  const _email: Expect<Equal<EmailInput, EmailMessage>> = true
  const _telegram: Expect<Equal<TelegramInput, TelegramMessage>> = true
  return { ok: _email && _telegram }
})
export type _ApiProcedure = typeof ping

// A jobs builder annotated in its own module gets the same exactness.
export const defineJobs = (
  jobs: BunderstackJobsBuilder<typeof schema, { TOKEN?: string }, Channels>,
) =>
  jobs.define({
    beat: jobs.job({
      input: v.object({}),
      handler: async (_input, ctx) => {
        type EmailInput = Parameters<typeof ctx.messaging.email.send>[0]
        type TelegramInput = Parameters<typeof ctx.messaging.ops.send>[0]
        const _email: Expect<Equal<EmailInput, EmailMessage>> = true
        const _telegram: Expect<Equal<TelegramInput, TelegramMessage>> = true
        void _email
        void _telegram
      },
    }),
  })
