// src/internal-tables-pg.ts — Postgres twins of the internal tables. Same
// table/column names and row shapes as the sqlite originals; timestamps stay
// integer milliseconds (bigint mode:number) so shared code never branches.
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const bunderstackFilesPg = pgTable(
  'bunderstack_file_meta',
  {
    fileId: text('file_id').primaryKey(),
    bucket: text('bucket').notNull(),
    ownerId: text('owner_id'),
    scopeJson: text('scope_json'),
    status: text('status').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    confirmedAt: bigint('confirmed_at', { mode: 'number' }),
  },
  (t) => [
    index('bfm_owner').on(t.ownerId),
    index('bfm_scope').on(t.bucket, t.scopeJson),
    index('bfm_sweep').on(t.status, t.createdAt),
  ],
)

export const bunderstackIdempotencyPg = pgTable(
  '_bunderstack_idempotency',
  {
    key: text('key').notNull(),
    tableName: text('table_name').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: integer('status').notNull(),
    response: text('response').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.tableName] })],
)

export const bunderstackJobsPg = pgTable(
  '_bunderstack_jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    runAt: bigint('run_at', { mode: 'number' }).notNull(),
    lockedUntil: bigint('locked_until', { mode: 'number' }),
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    finishedAt: bigint('finished_at', { mode: 'number' }),
  },
  (t) => [
    index('bjq_claim').on(t.status, t.runAt),
    index('bjq_type_status').on(t.type, t.status),
    uniqueIndex('bjq_dedupe').on(t.type, t.dedupeKey),
  ],
)
