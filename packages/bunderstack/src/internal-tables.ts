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
  bunderstackMessageEventsPg,
  bunderstackMessagesPg,
  bunderstackContactsPg,
  bunderstackContactAddressesPg,
  bunderstackContactTagsPg,
  bunderstackBroadcastsPg,
  bunderstackBroadcastRecipientsPg,
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
    // The claim path: (type, status) alone leaves run_at to a row-by-row filter
    // over every finished row of that type, so the third column belongs here.
    // This also covers the (type, status) running-count probe as a prefix.
    index('bjq_ready').on(t.type, t.status, t.runAt),
    index('bjq_claim').on(t.status, t.runAt),
    // The retention sweep filters on finishedAt, which bjq_claim does not carry.
    index('bjq_reap').on(t.status, t.finishedAt),
    index('bjq_type_run_at').on(t.type, t.runAt),
    // NULL dedupe keys are distinct in both dialects, so keyless jobs never collide.
    uniqueIndex('bjq_dedupe').on(t.type, t.dedupeKey),
  ],
)

export const bunderstackMessages = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('bmsg_created').on(t.createdAt),
    index('bmsg_channel_status').on(t.channel, t.status, t.createdAt),
    uniqueIndex('bmsg_provider_id').on(t.provider, t.providerId),
  ],
)

export const bunderstackMessageEvents = sqliteTable(
  '_bunderstack_message_events',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => bunderstackMessages.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    detailJson: text('detail_json'),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bmev_external').on(t.externalId),
    index('bmev_message_time').on(t.messageId, t.occurredAt),
  ],
)

/** People an application can write to, users or not. */
export const bunderstackContacts = sqliteTable(
  '_bunderstack_contacts',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    userId: text('user_id'),
    source: text('source'),
    attributesJson: text('attributes_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('bct_created').on(t.createdAt),
    index('bct_source').on(t.source),
    index('bct_user').on(t.userId),
  ],
)

/** One way to reach a contact; consent and opt-out belong to the address. */
export const bunderstackContactAddresses = sqliteTable(
  '_bunderstack_contact_addresses',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => bunderstackContacts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    address: text('address').notNull(),
    consentedAt: integer('consented_at'),
    consentSource: text('consent_source'),
    unsubscribedAt: integer('unsubscribed_at'),
    suppressedAt: integer('suppressed_at'),
    suppressedReason: text('suppressed_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bca_address').on(t.kind, t.address),
    index('bca_contact').on(t.contactId),
  ],
)

export const bunderstackContactTags = sqliteTable(
  '_bunderstack_contact_tags',
  {
    contactId: text('contact_id')
      .notNull()
      .references(() => bunderstackContacts.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tag] }),
    index('bctag_tag').on(t.tag),
  ],
)

/** A message to many contacts, sent by the application's worker. */
export const bunderstackBroadcasts = sqliteTable(
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
    scheduledAt: integer('scheduled_at'),
    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
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
export const bunderstackBroadcastRecipients = sqliteTable(
  '_bunderstack_broadcast_recipients',
  {
    id: text('id').primaryKey(),
    broadcastId: text('broadcast_id')
      .notNull()
      .references(() => bunderstackBroadcasts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull(),
    addressId: text('address_id').notNull(),
    address: text('address').notNull(),
    // queued | sending | sent | failed | delivered | opened | clicked | bounced | complained
    status: text('status').notNull(),
    providerId: text('provider_id'),
    error: text('error'),
    sentAt: integer('sent_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('bbr_address').on(t.broadcastId, t.addressId),
    index('bbr_status').on(t.broadcastId, t.status),
    index('bbr_created').on(t.createdAt),
  ],
)

export const INTERNAL_TABLES = {
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
  bunderstackMessages,
  bunderstackMessageEvents,
  bunderstackContacts,
  bunderstackContactAddresses,
  bunderstackContactTags,
  bunderstackBroadcasts,
  bunderstackBroadcastRecipients,
} as const

export const INTERNAL_TABLE_NAMES: ReadonlySet<string> = new Set([
  'bunderstack_file_meta',
  '_bunderstack_idempotency',
  '_bunderstack_jobs',
  '_bunderstack_messages',
  '_bunderstack_message_events',
  '_bunderstack_contacts',
  '_bunderstack_contact_addresses',
  '_bunderstack_contact_tags',
  '_bunderstack_broadcasts',
  '_bunderstack_broadcast_recipients',
])

export const INTERNAL_TABLES_PG = {
  bunderstackFiles: bunderstackFilesPg,
  bunderstackIdempotency: bunderstackIdempotencyPg,
  bunderstackJobs: bunderstackJobsPg,
  bunderstackMessages: bunderstackMessagesPg,
  bunderstackMessageEvents: bunderstackMessageEventsPg,
  bunderstackContacts: bunderstackContactsPg,
  bunderstackContactAddresses: bunderstackContactAddressesPg,
  bunderstackContactTags: bunderstackContactTagsPg,
  bunderstackBroadcasts: bunderstackBroadcastsPg,
  bunderstackBroadcastRecipients: bunderstackBroadcastRecipientsPg,
} as const

// Both dialect twins count as "ours" for the re-export identity check.
const INTERNAL_TABLE_CANDIDATES = new Map<string, readonly unknown[]>([
  [getTableName(bunderstackFiles), [bunderstackFiles, bunderstackFilesPg]],
  [
    getTableName(bunderstackIdempotency),
    [bunderstackIdempotency, bunderstackIdempotencyPg],
  ],
  [getTableName(bunderstackJobs), [bunderstackJobs, bunderstackJobsPg]],
  [
    getTableName(bunderstackMessages),
    [bunderstackMessages, bunderstackMessagesPg],
  ],
  [
    getTableName(bunderstackMessageEvents),
    [bunderstackMessageEvents, bunderstackMessageEventsPg],
  ],
  [
    getTableName(bunderstackContacts),
    [bunderstackContacts, bunderstackContactsPg],
  ],
  [
    getTableName(bunderstackContactAddresses),
    [bunderstackContactAddresses, bunderstackContactAddressesPg],
  ],
  [
    getTableName(bunderstackContactTags),
    [bunderstackContactTags, bunderstackContactTagsPg],
  ],
  [
    getTableName(bunderstackBroadcasts),
    [bunderstackBroadcasts, bunderstackBroadcastsPg],
  ],
  [
    getTableName(bunderstackBroadcastRecipients),
    [bunderstackBroadcastRecipients, bunderstackBroadcastRecipientsPg],
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

export function messagesTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackMessagesPg : bunderstackMessages
}

export function messageEventsTableFor(db: unknown) {
  return is(db, PgDatabase)
    ? bunderstackMessageEventsPg
    : bunderstackMessageEvents
}

export function contactTablesFor(db: unknown) {
  return is(db, PgDatabase)
    ? {
        contacts: bunderstackContactsPg,
        addresses: bunderstackContactAddressesPg,
        tags: bunderstackContactTagsPg,
      }
    : {
        contacts: bunderstackContacts,
        addresses: bunderstackContactAddresses,
        tags: bunderstackContactTags,
      }
}

export function broadcastTablesFor(db: unknown) {
  return is(db, PgDatabase)
    ? {
        broadcasts: bunderstackBroadcastsPg,
        recipients: bunderstackBroadcastRecipientsPg,
      }
    : {
        broadcasts: bunderstackBroadcasts,
        recipients: bunderstackBroadcastRecipients,
      }
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
