import { getTableName, isTable } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

export const bunderstackFiles = sqliteTable(
  'bunderstack_file_meta',
  {
    fileId: text('file_id').primaryKey(),
    bucket: text('bucket').notNull(),
    ownerId: text('owner_id'),
    scopeJson: text('scope_json'),
    status: text('status').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    size: integer('size'),
    createdAt: integer('created_at').notNull(),
    confirmedAt: integer('confirmed_at'),
  },
  (t) => [
    index('bfm_owner').on(t.ownerId),
    index('bfm_scope').on(t.bucket, t.scopeJson),
    index('bfm_sweep').on(t.status, t.createdAt),
  ],
)

export const bunderstackIdempotency = sqliteTable(
  '_bunderstack_idempotency',
  {
    key: text('key').notNull(),
    tableName: text('table_name').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: integer('status').notNull(),
    response: text('response').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.tableName] })],
)

export const INTERNAL_TABLES = {
  bunderstackFiles,
  bunderstackIdempotency,
} as const

export const INTERNAL_TABLE_NAMES: ReadonlySet<string> = new Set([
  'bunderstack_file_meta',
  '_bunderstack_idempotency',
])

const INTERNAL_TABLE_BY_NAME = new Map<string, (typeof INTERNAL_TABLES)[keyof typeof INTERNAL_TABLES]>([
  [getTableName(bunderstackFiles), bunderstackFiles],
  [getTableName(bunderstackIdempotency), bunderstackIdempotency],
])

export function withInternalTables<TSchema extends Record<string, unknown>>(
  schema: TSchema,
): TSchema & typeof INTERNAL_TABLES {
  const merged = { ...schema } as TSchema & typeof INTERNAL_TABLES

  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue
    const name = getTableName(value)
    if (!INTERNAL_TABLE_NAMES.has(name)) continue

    const internal = INTERNAL_TABLE_BY_NAME.get(name)
    if (internal === value) {
      // Re-exported from bunderstack/schema — already in user schema.
      continue
    }

    throw new Error(
      `[bunderstack] table name "${name}" is reserved by bunderstack`,
    )
  }

  for (const [key, table] of Object.entries(INTERNAL_TABLES)) {
    if (!(key in merged)) {
      ;(merged as Record<string, unknown>)[key] = table
    }
  }

  return merged
}
