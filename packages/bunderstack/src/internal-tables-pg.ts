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
    index('bjq_type_run_at').on(t.type, t.runAt),
    uniqueIndex('bjq_dedupe').on(t.type, t.dedupeKey),
  ],
)

export const bunderstackMessagesPg = pgTable(
  '_bunderstack_messages',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    credentialSource: text('credential_source').notNull(),
    providerId: text('provider_id'),
    status: text('status').notNull(),
    recipientsJson: text('recipients_json').notNull(),
    contentJson: text('content_json').notNull(),
    error: text('error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('bmsg_created').on(t.createdAt),
    index('bmsg_channel_status').on(t.channel, t.status, t.createdAt),
    uniqueIndex('bmsg_provider_id').on(t.provider, t.providerId),
  ],
)

export const bunderstackMessageEventsPg = pgTable(
  '_bunderstack_message_events',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => bunderstackMessagesPg.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    detailJson: text('detail_json'),
    occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('bmev_external').on(t.externalId),
    index('bmev_message_time').on(t.messageId, t.occurredAt),
  ],
)
