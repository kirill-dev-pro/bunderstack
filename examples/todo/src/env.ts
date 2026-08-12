import * as v from 'valibot'

/**
 * Env validation: all vars checked at boot, `app.env` fully typed.
 * Server vars must NOT start with PUBLIC_; client vars MUST.
 *
 * Declared here rather than inline in the config, so `api.ts` can pass the
 * same schema to `defineApi` and type `context.env`.
 */
export const envSchema = {
  server: {
    NOTIFY_COMPLETED: v.optional(
      v.pipe(v.picklist(['true', 'false']), v.transform((value) => value === 'true')),
      'true',
    ),
  },
  client: {
    PUBLIC_APP_NAME: v.optional(v.string(), 'Todo Example'),
  },
}
