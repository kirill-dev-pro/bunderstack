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
  bunderstackEmailEventsPg,
  bunderstackEmailsPg,
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

export const bunderstackEmails = sqliteTable(
  '_bunderstack_emails',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    providerId: text('provider_id'),
    status: text('status').notNull(),
    from: text('from_address').notNull(),
    toJson: text('to_json').notNull(),
    ccJson: text('cc_json').notNull(),
    bccJson: text('bcc_json').notNull(),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    html: text('html'),
    text: text('text'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('bem_created').on(t.createdAt),
    index('bem_status').on(t.status, t.createdAt),
    uniqueIndex('bem_provider_id').on(t.provider, t.providerId),
  ],
)

export const bunderstackEmailEvents = sqliteTable(
  '_bunderstack_email_events',
  {
    id: text('id').primaryKey(),
    emailId: text('email_id')
      .notNull()
      .references(() => bunderstackEmails.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    detailJson: text('detail_json'),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('beev_external').on(t.externalId),
    index('beev_email_time').on(t.emailId, t.occurredAt),
  ],
)

export const INTERNAL_TABLES = {
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
  bunderstackEmails,
  bunderstackEmailEvents,
} as const

export const INTERNAL_TABLE_NAMES: ReadonlySet<string> = new Set([
  'bunderstack_file_meta',
  '_bunderstack_idempotency',
  '_bunderstack_jobs',
  '_bunderstack_emails',
  '_bunderstack_email_events',
])

export const INTERNAL_TABLES_PG = {
  bunderstackFiles: bunderstackFilesPg,
  bunderstackIdempotency: bunderstackIdempotencyPg,
  bunderstackJobs: bunderstackJobsPg,
  bunderstackEmails: bunderstackEmailsPg,
  bunderstackEmailEvents: bunderstackEmailEventsPg,
} as const

// Both dialect twins count as "ours" for the re-export identity check.
const INTERNAL_TABLE_CANDIDATES = new Map<string, readonly unknown[]>([
  [getTableName(bunderstackFiles), [bunderstackFiles, bunderstackFilesPg]],
  [
    getTableName(bunderstackIdempotency),
    [bunderstackIdempotency, bunderstackIdempotencyPg],
  ],
  [getTableName(bunderstackJobs), [bunderstackJobs, bunderstackJobsPg]],
  [getTableName(bunderstackEmails), [bunderstackEmails, bunderstackEmailsPg]],
  [
    getTableName(bunderstackEmailEvents),
    [bunderstackEmailEvents, bunderstackEmailEventsPg],
  ],
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

/** Internal email journal table matching the db's dialect. */
export function emailsTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackEmailsPg : bunderstackEmails
}

/** Internal email event table matching the db's dialect. */
export function emailEventsTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackEmailEventsPg : bunderstackEmailEvents
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
