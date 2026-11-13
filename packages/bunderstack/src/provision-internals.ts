import type { Driver } from './db'
// src/provision-internals.ts
import type { AnyDb, Dialect } from './dialect'

/**
 * Hidden handle connecting `bunderstack()` to the optional
 * `bunderstack/provision` entry. Lives in its own module so the main entry
 * never imports provisioning code.
 */
export const PROVISION_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.provision-internals',
)

export interface ProvisionInternals {
  /** Runtime db typed over the MERGED schema (user + internal tables). */
  db: AnyDb
  /** Merged schema used for push. */
  schema: Record<string, unknown>
  databaseUrl: string
  /** Resolved migrations folder (config `database.migrations`). */
  migrationsFolder: string
  dialect: Dialect
  driver: Driver
  adapter: import('./database/adapter').DatabaseAdapter
  /** The application's own tables, without the system ones. */
  userSchema: Record<string, unknown>
  /** The validated environment the application was started with. */
  env: import('./env').BaseEnv
  /** `database.seed`, when the application declares one. */
  seed?: import('./config').SeedLoader
  /** Whether this process was started with `BUNDERSTACK_SEED=1`. */
  seedRequested: boolean
}

export interface WithProvisionInternals {
  [PROVISION_INTERNALS]?: ProvisionInternals
}
