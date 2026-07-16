// src/typeid-pg.ts — Postgres twin of the typeid column builder. The codec
// (generate/parse/encode/decode) is dialect-neutral and lives in ./typeid;
// only the drizzle customType wrapper differs.
import { customType } from 'drizzle-orm/pg-core'

import { isValidPrefix, type TypeId } from './typeid'

/**
 * Drizzle column builder for a branded TypeID text value (Postgres). Stores a
 * plain `text` column so drizzle-kit migrations and `$inferSelect` work
 * unchanged.
 *
 *   id: typeid('post').primaryKey().$defaultFn(() => generate('post'))
 */
export function typeid<P extends string>(prefix: P) {
  if (!isValidPrefix(prefix))
    throw new Error(`Invalid typeid prefix: "${prefix}"`)
  return customType<{ data: TypeId<P>; driverData: string }>({
    dataType: () => 'text',
  })()
}

export { generate, parse, asTypeId, encode, decode } from './typeid'
export type { TypeId } from './typeid'
