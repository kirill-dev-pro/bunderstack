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
    // The claim path: (type, status) alone leaves run_at to a row-by-row filter
    // over every finished row of that type, so the third column belongs here.
    // This also covers the (type, status) running-count probe as a prefix.
    index('bjq_ready').on(t.type, t.status, t.runAt),
    index('bjq_claim').on(t.status, t.runAt),
    // The retention sweep filters on finishedAt, which bjq_claim does not carry.
    index('bjq_reap').on(t.status, t.finishedAt),
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

/** People an application can write to, users or not. */
export const bunderstackContactsPg = pgTable(
  '_bunderstack_contacts',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    userId: text('user_id'),
    source: text('source'),
    attributesJson: text('attributes_json').notNull().default('{}'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('bct_created').on(t.createdAt),
    index('bct_source').on(t.source),
    index('bct_user').on(t.userId),
  ],
)

/** One way to reach a contact; consent and opt-out belong to the address. */
export const bunderstackContactAddressesPg = pgTable(
  '_bunderstack_contact_addresses',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => bunderstackContactsPg.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    address: text('address').notNull(),
    consentedAt: bigint('consented_at', { mode: 'number' }),
    consentSource: text('consent_source'),
    unsubscribedAt: bigint('unsubscribed_at', { mode: 'number' }),
    suppressedAt: bigint('suppressed_at', { mode: 'number' }),
    suppressedReason: text('suppressed_reason'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('bca_address').on(t.kind, t.address),
    index('bca_contact').on(t.contactId),
  ],
)

export const bunderstackContactTagsPg = pgTable(
  '_bunderstack_contact_tags',
  {
    contactId: text('contact_id')
      .notNull()
      .references(() => bunderstackContactsPg.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tag] }),
    index('bctag_tag').on(t.tag),
  ],
)

/** A message to many contacts, sent by the application's worker. */
export const bunderstackBroadcastsPg = pgTable(
  '_bunderstack_broadcasts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    channel: text('channel').notNull(),
    fromAddress: text('from_address'),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text'),
    audienceJson: text('audience_json').notNull().default('{}'),
    // draft | approved | sending | sent | cancelled | failed
    status: text('status').notNull(),
    scheduledAt: bigint('scheduled_at', { mode: 'number' }),
    approvedBy: text('approved_by'),
    approvedAt: bigint('approved_at', { mode: 'number' }),
    startedAt: bigint('started_at', { mode: 'number' }),
    finishedAt: bigint('finished_at', { mode: 'number' }),
    error: text('error'),
    recipients: integer('recipients').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    opened: integer('opened').notNull().default(0),
    clicked: integer('clicked').notNull().default(0),
    bounced: integer('bounced').notNull().default(0),
    complained: integer('complained').notNull().default(0),
    unsubscribed: integer('unsubscribed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('bbc_created').on(t.createdAt),
    index('bbc_status').on(t.status),
  ],
)

/**
 * One address a broadcast goes to, snapshotted when sending starts so later
 * contacts do not receive it. Folded into the broadcast's counters and deleted
 * after 90 days.
 */
export const bunderstackBroadcastRecipientsPg = pgTable(
  '_bunderstack_broadcast_recipients',
  {
    id: text('id').primaryKey(),
    broadcastId: text('broadcast_id')
      .notNull()
      .references(() => bunderstackBroadcastsPg.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull(),
    addressId: text('address_id').notNull(),
    address: text('address').notNull(),
    // queued | sending | sent | failed | delivered | opened | clicked | bounced | complained
    status: text('status').notNull(),
    providerId: text('provider_id'),
    error: text('error'),
    sentAt: bigint('sent_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('bbr_address').on(t.broadcastId, t.addressId),
    index('bbr_status').on(t.broadcastId, t.status),
    index('bbr_created').on(t.createdAt),
  ],
)
