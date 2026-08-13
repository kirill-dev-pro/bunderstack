// src/schema-export-pg.ts — pg twins under the same names bunderstack/schema
// uses, so `export * from 'bunderstack/schema/pg'` mirrors the sqlite setup.
export {
  bunderstackEmailEventsPg as bunderstackEmailEvents,
  bunderstackEmailsPg as bunderstackEmails,
  bunderstackFilesPg as bunderstackFiles,
  bunderstackIdempotencyPg as bunderstackIdempotency,
  bunderstackJobsPg as bunderstackJobs,
} from './internal-tables-pg'
