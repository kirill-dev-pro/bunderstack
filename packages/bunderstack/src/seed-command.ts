// What the CLI does with a seed: run it by hand against a local database,
// and try it against a throwaway one when the blueprint is generated.
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { BunderstackBackend } from './backend'
import type { MigrationMode } from './blueprint'

import { entryFor, loadBackend, type AppPackage } from './app-entry'
import { BACKEND_INTERNALS } from './backend-internals'
import { getProvisionInternals } from './provision-runtime'
import {
  isLocalDatabaseUrl,
  resetSeededDatabase,
  runSeed,
  type SeedOutcome,
} from './seed-runtime'

/** Runs `work` with the application's directory as the working directory. */
async function within<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  // Migrations, a local database file and whatever the seed reads are all
  // named relative to the application.
  const previous = process.cwd()
  process.chdir(directory)
  try {
    return await work()
  } finally {
    process.chdir(previous)
  }
}

export type SeedCommandOptions = {
  directory: string
  entry?: string
  /** Empty the application's tables first, so the seed runs again. */
  reset?: boolean
}

export type SeedCommandResult = {
  outcome: Exclude<SeedOutcome, 'not-asked'>
  /** The tables `--reset` emptied. */
  emptied?: string[]
}

/**
 * `bunderstack seed`: bring the schema up, then seed. For the database on
 * this machine only: a hosted one is seeded by its host, which is the only
 * one that knows whether it is a preview.
 */
export async function seedCommand(
  options: SeedCommandOptions,
): Promise<SeedCommandResult> {
  const directory = await realpath(resolve(options.directory))
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  ) as AppPackage
  return within(directory, async () => {
    const backend = await loadBackend(directory, entryFor(pkg, options.entry))
    // The command itself is the request; the variable must not seed a second
    // time from inside provisioning.
    const { BUNDERSTACK_SEED: _asked, ...source } = process.env as Record<
      string,
      string | undefined
    >
    const app = (await backend[BACKEND_INTERNALS].start(source, {
      backgroundAutoStart: false,
    })) as { close(): Promise<void> }
    try {
      const internals = getProvisionInternals(app)
      if (!internals.seed) return { outcome: 'not-declared' as const }
      if (!isLocalDatabaseUrl(internals.databaseUrl)) {
        throw new Error(
          '[bunderstack] `bunderstack seed` runs against a local database, and this one is remote. A hosted preview is seeded by its host; nothing seeds production.',
        )
      }
      const { ensureSchema } = await import('./provision-schema')
      await ensureSchema(app)
      const emptied = options.reset ? await resetSeededDatabase(app) : undefined
      const outcome = await runSeed(app)
      return { outcome, ...(emptied ? { emptied } : {}) }
    } finally {
      await app.close()
    }
  })
}

export type SeedCheck =
  | { status: 'passed' }
  /** There was nothing to run it against; `reason` says why. */
  | { status: 'skipped'; reason: string }

/**
 * Runs a declared seed against a throwaway database with the application's
 * schema, so a seed that no longer fits the tables fails where the blueprint
 * is generated instead of in somebody's preview. The application is started
 * the way `backend.test()` starts it: nothing leaves the machine.
 */
export async function checkSeed(args: {
  backend: BunderstackBackend<any>
  directory: string
  /** A source that satisfies the declared environment. */
  env: Record<string, string | undefined>
  migrationMode: MigrationMode
}): Promise<SeedCheck> {
  const inspected = args.backend[BACKEND_INTERNALS].inspect(args.env)
  const adapter = inspected.config.database.adapter
  if (!adapter.testing) {
    return {
      status: 'skipped',
      reason: `the ${adapter.driver} adapter has no throwaway database to run it against`,
    }
  }
  return within(args.directory, async () => {
    const { BUNDERSTACK_SEED: _asked, ...env } = args.env
    const fixture = await args.backend.test({
      env,
      database: { mode: 'temporary', schema: args.migrationMode },
      logs: 'capture',
    })
    try {
      await runSeed(fixture.app as object)
      return { status: 'passed' as const }
    } finally {
      await fixture.close()
    }
  })
}
