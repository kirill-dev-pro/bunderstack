import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

export function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: { url: string; authToken?: string },
) {
  const client = createClient({ url: cfg.url, authToken: cfg.authToken })
  return drizzle(client, { schema })
}
