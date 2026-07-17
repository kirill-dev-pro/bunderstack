import { getTableName, is, isTable } from 'drizzle-orm'
import { PgDatabase } from 'drizzle-orm/pg-core'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import { detectDialect } from './dialect'
import {
  bunderstackFilesPg,
  bunderstackIdempotencyPg,
  bunderstackJobsPg,
} from './internal-tables-pg'

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

export const bunderstackJobs = sqliteTable(
  '_bunderstack_jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull(), // pending | running | succeeded | failed
    attempts: integer('attempts').notNull().default(0),
    runAt: integer('run_at').notNull(),
    lockedUntil: integer('locked_until'),
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('bjq_claim').on(t.status, t.runAt),
    index('bjq_type_status').on(t.type, t.status),
    // NULL dedupe keys are distinct in both dialects, so keyless jobs never collide.
    uniqueIndex('bjq_dedupe').on(t.type, t.dedupeKey),
  ],
)

export const INTERNAL_TABLES = {
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
} as const

export const INTERNAL_TABLE_NAMES: ReadonlySet<string> = new Set([
  'bunderstack_file_meta',
  '_bunderstack_idempotency',
  '_bunderstack_jobs',
])

export const INTERNAL_TABLES_PG = {
  bunderstackFiles: bunderstackFilesPg,
  bunderstackIdempotency: bunderstackIdempotencyPg,
  bunderstackJobs: bunderstackJobsPg,
} as const

// Both dialect twins count as "ours" for the re-export identity check.
const INTERNAL_TABLE_CANDIDATES = new Map<string, readonly unknown[]>([
  [getTableName(bunderstackFiles), [bunderstackFiles, bunderstackFilesPg]],
  [
    getTableName(bunderstackIdempotency),
    [bunderstackIdempotency, bunderstackIdempotencyPg],
  ],
  [getTableName(bunderstackJobs), [bunderstackJobs, bunderstackJobsPg]],
])

/** Internal file-meta table matching the db's dialect. */
export function filesTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackFilesPg : bunderstackFiles
}

/** Internal idempotency table matching the db's dialect. */
export function idempotencyTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackIdempotencyPg : bunderstackIdempotency
}

/** Internal jobs table matching the db's dialect. */
export function jobsTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackJobsPg : bunderstackJobs
}

export function withInternalTables<TSchema extends Record<string, unknown>>(
  schema: TSchema,
): TSchema & typeof INTERNAL_TABLES {
  const merged = { ...schema } as TSchema & typeof INTERNAL_TABLES

  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue
    const name = getTableName(value)
    if (!INTERNAL_TABLE_NAMES.has(name)) continue

    const candidates = INTERNAL_TABLE_CANDIDATES.get(name)
    if (candidates?.includes(value)) {
      // Re-exported from bunderstack/schema(-pg) — already in user schema.
      continue
    }

    throw new Error(
      `[bunderstack] table name "${name}" is reserved by bunderstack`,
    )
  }

  const internal =
    detectDialect(schema) === 'pg' ? INTERNAL_TABLES_PG : INTERNAL_TABLES
  for (const [key, table] of Object.entries(internal)) {
    if (!(key in merged)) {
      ;(merged as Record<string, unknown>)[key] = table
    }
  }

  return merged
}
