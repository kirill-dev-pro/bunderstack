import type { ValidatedEnv } from 'bunderstack/env'
import { z } from 'zod'

/**
 * Declared environment. These names reach the deployment blueprint, which is
 * how the host learns what the application needs. Server variables must not use
 * the PUBLIC_ prefix; browser-safe variables must.
 */
export const envSchema = {
  server: {
    EMAIL_FROM: z.string().min(1).default('Relay <hello@example.com>'),
    RESEND_API_KEY: z.string().optional(),
    REDIS_URL: z.string().optional(),
  },
  client: {
    PUBLIC_APP_NAME: z.string().min(1).default('Relay'),
  },
}

/**
 * The validated env as jobs and procedures receive it. Job and tRPC builders
 * declared in their own modules need this to match the entry's inference.
 */
export type RelayEnv = ValidatedEnv<typeof envSchema>
