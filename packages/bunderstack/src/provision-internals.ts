// src/provision-internals.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

/**
 * Hidden handle connecting `createBunderstack()` to the optional
 * `bunderstack/provision` entry. Lives in its own module so the main entry
 * never imports provision code (and its drizzle-kit reference).
 */
export const PROVISION_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.provision-internals',
)

export interface ProvisionInternals {
  /** Runtime db typed over the MERGED schema (user + internal tables). */
  db: LibSQLDatabase<Record<string, unknown>>
  /** Merged schema used for push. */
  schema: Record<string, unknown>
  databaseUrl: string
  /** Resolved migrations folder (config `database.migrations`). */
  migrationsFolder: string
}

export interface WithProvisionInternals {
  [PROVISION_INTERNALS]?: ProvisionInternals
}
