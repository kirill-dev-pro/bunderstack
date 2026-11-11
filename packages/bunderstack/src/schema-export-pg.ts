// src/schema-export-pg.ts — pg twins under the same names bunderstack/schema
// uses, so `export * from 'bunderstack/schema-pg'` mirrors the sqlite setup.
export {
  bunderstackMessageEventsPg as bunderstackMessageEvents,
  bunderstackMessagesPg as bunderstackMessages,
  bunderstackFilesPg as bunderstackFiles,
  bunderstackIdempotencyPg as bunderstackIdempotency,
  bunderstackJobsPg as bunderstackJobs,
  bunderstackContactsPg as bunderstackContacts,
  bunderstackContactAddressesPg as bunderstackContactAddresses,
  bunderstackContactTagsPg as bunderstackContactTags,
  bunderstackBroadcastsPg as bunderstackBroadcasts,
  bunderstackBroadcastRecipientsPg as bunderstackBroadcastRecipients,
} from './internal-tables-pg'
