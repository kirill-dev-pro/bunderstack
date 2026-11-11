import type { ValidatedEnv } from 'bunderstack/env'

import * as v from 'valibot'

/**
 * Declared environment. These names reach the deployment blueprint, which is
 * how the host learns what the application needs. Server variables must not use
 * the PUBLIC_ prefix; browser-safe variables must.
 */
export const envSchema = {
  server: {
    /** Overrides the sender chosen on the host's Messaging tab. */
    EMAIL_FROM: v.optional(v.pipe(v.string(), v.minLength(1))),
    REDIS_URL: v.optional(v.string()),
  },
  client: {
    PUBLIC_APP_NAME: v.optional(v.pipe(v.string(), v.minLength(1)), 'Relay'),
  },
}

/**
 * The validated env as jobs and procedures receive it. Builders
 * declared in their own modules need this to match the entry's inference.
 */
export type RelayEnv = ValidatedEnv<typeof envSchema>
