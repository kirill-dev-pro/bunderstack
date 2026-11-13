// Runs an application's seed: once per database, in one transaction with the
// mark that says it ran. Nothing here decides to seed by itself. `provision`
// asks only when the process was started with `BUNDERSTACK_SEED=1`, and the
// CLI asks because a person typed the command.
import { getTableName, isTable, sql } from 'drizzle-orm'

import type { AnyDb } from './dialect'

import {
  INTERNAL_TABLE_NAMES,
  bunderstackSeed,
  seedTableFor,
} from './internal-tables'
import { getProvisionInternals } from './provision-runtime'
import { seedFromModule } from './seed'
import { BUNDERSTACK_VERSION } from './version'

/** The one row of `_bunderstack_seed`. */
const MARK_ID = 'seed'

export type SeedOutcome =
  /** The seed ran and its rows are in the database. */
  | 'seeded'
  /** The database carries the mark of an earlier seed; nothing ran. */
  | 'already-seeded'
  /** The application declares no seed. */
  | 'not-declared'
  /** Nobody asked: the process was not started with `BUNDERSTACK_SEED=1`. */
  | 'not-asked'

const REMOTE_URL = /^(postgres(ql)?|libsql|wss?|https?):\/\//

/** Whether a database URL names a file or memory of this machine. */
export function isLocalDatabaseUrl(url: string): boolean {
  return !REMOTE_URL.test(url)
}

type Loose = {
  run(query: unknown): unknown
  execute(query: unknown): Promise<unknown>
  transaction<T>(run: (tx: AnyDb) => Promise<T>): Promise<T>
}

/**
 * One transaction around `run`. A local SQLite database is the odd one, with
 * either driver: `bun:sqlite` has a single connection and drizzle's
 * transaction for it takes no asynchronous work, and the libSQL client hands
 * its connection to the transaction and opens another afterwards, which for
 * `:memory:` is another, empty database. So there the transaction is opened
 * by hand on the application's own connection, and `run` is given the
 * database itself. A remote database and Postgres get the driver's own
 * transaction.
 */
async function inTransaction<T>(
  target: { db: AnyDb; dialect: string; databaseUrl: string },
  run: (tx: AnyDb) => Promise<T>,
): Promise<T> {
  const connection = target.db as unknown as Loose
  if (target.dialect !== 'sqlite' || !isLocalDatabaseUrl(target.databaseUrl)) {
    return connection.transaction(run)
  }
  await connection.run(sql`BEGIN IMMEDIATE`)
  try {
    const result = await run(insideTransaction(target.db))
    await connection.run(sql`COMMIT`)
    return result
  } catch (error) {
    await connection.run(sql`ROLLBACK`)
    throw error
  }
}

/**
 * The application's database while a transaction opened by hand is running
 * on it, behaving as a driver's transaction handle does: a transaction
 * inside it is a savepoint, not a second `BEGIN` the connection would refuse.
 */
function insideTransaction(db: AnyDb): AnyDb {
  const connection = db as unknown as Loose
  let depth = 0
  const handle: AnyDb = new Proxy(db as object, {
    get(target, property) {
      if (property === 'transaction') {
        return async (run: (tx: AnyDb) => Promise<unknown>) => {
          const name = `bunderstack_seed_${++depth}`
          await connection.run(sql.raw(`SAVEPOINT ${name}`))
          try {
            const result = await run(handle)
            await connection.run(sql.raw(`RELEASE ${name}`))
            return result
          } catch (error) {
            await connection.run(sql.raw(`ROLLBACK TO ${name}`))
            await connection.run(sql.raw(`RELEASE ${name}`))
            throw error
          } finally {
            depth--
          }
        }
      }
      if (property === 'rollback') {
        return () => {
          throw new Error('[bunderstack] the seed rolled its transaction back')
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as AnyDb
  return handle
}

function describe(error: unknown): string {
  // Drizzle wraps a driver's error; the driver's own message is the cause.
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error && parts.length < 3) {
    // A driver's error is often wrapped with its own message repeated.
    if (!parts.some((part) => part.includes((current as Error).message))) {
      parts.push(current.message)
    }
    current = current.cause
  }
  return parts.join(': ') || String(error)
}

function markTableMissing(error: unknown): boolean {
  const text = describe(error)
  return (
    text.includes(getTableName(bunderstackSeed)) &&
    /no such table|does not exist/i.test(text)
  )
}

const MARK_TABLE_MISSING =
  '[bunderstack] the table _bunderstack_seed is missing. It comes with ' +
  'bunderstack/schema: run your `db:generate` command, commit the migration ' +
  'and start again.'

/**
 * A remote libSQL database (Turso, sqld) does not hold a transaction open
 * for ever: measured on sqld 0.24, it ends one that has run five seconds once
 * another write is waiting, and one that has sent nothing for ten.
 */
const TRANSACTION_CUT_SHORT = /TRANSACTION_TIMEOUT|STREAM_EXPIRED/
const KEEP_IT_SHORT =
  ' The database ended the seed’s transaction: it allows about five ' +
  'seconds once the application writes anything else, and ten without a ' +
  'statement. Insert rows in batches (`.values([...])`) and keep slow work ' +
  'out of the seed.'

/** Thrown when the seed's own code failed; nothing it wrote is kept. */
export class SeedFailedError extends Error {
  constructor(cause: unknown) {
    const reason = describe(cause)
    super(
      `[bunderstack] the seed failed, and nothing it wrote was kept: ${reason}` +
        (TRANSACTION_CUT_SHORT.test(reason) ? `.${KEEP_IT_SHORT}` : ''),
      { cause },
    )
    this.name = 'SeedFailedError'
  }
}

/**
 * Seeds the application's database unless it already carries the mark. For
 * the caller that has decided a seed is wanted: the CLI, and
 * {@link seedIfAsked}.
 */
export async function runSeed(
  app: object,
): Promise<Exclude<SeedOutcome, 'not-asked'>> {
  const internals = getProvisionInternals(app)
  if (!internals.seed) return 'not-declared'
  const definition = seedFromModule(await internals.seed())
  const table = seedTableFor(internals.db)
  let failed: unknown
  try {
    return await inTransaction(internals, async (tx) => {
      // The mark goes in first, so a second process starting on the same
      // database waits for this one and then finds the database seeded.
      const claimed = (await (tx as any)
        .insert(table)
        .values({
          id: MARK_ID,
          seededAt: Date.now(),
          version: BUNDERSTACK_VERSION,
          revision: internals.env.BUNDERSTACK_REVISION ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: table.id })) as unknown[]
      if (claimed.length === 0) return 'already-seeded'
      try {
        await definition.run({
          db: tx,
          schema: internals.userSchema,
          env: internals.env,
        })
      } catch (error) {
        failed = error
        throw error
      }
      return 'seeded'
    })
  } catch (error) {
    if (failed !== undefined) throw new SeedFailedError(failed)
    if (markTableMissing(error))
      throw new Error(MARK_TABLE_MISSING, { cause: error })
    throw error
  }
}

/**
 * What `provision(app)` calls after the schema is in place: seeds only when
 * this process was started with `BUNDERSTACK_SEED=1`.
 */
export async function seedIfAsked(app: object): Promise<SeedOutcome> {
  const internals = getProvisionInternals(app)
  if (!internals.seedRequested) return 'not-asked'
  const outcome = await runSeed(app)
  if (outcome === 'seeded') {
    console.log('[bunderstack] seeded the database')
  }
  return outcome
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Empties the application's own tables and removes the mark, so the next
 * seed starts from nothing. System tables other than the mark are left.
 * Refused for anything but a database on this machine.
 */
export async function resetSeededDatabase(app: object): Promise<string[]> {
  const internals = getProvisionInternals(app)
  if (!isLocalDatabaseUrl(internals.databaseUrl)) {
    throw new Error(
      '[bunderstack] --reset empties the application’s tables, so it runs only against a local database; this one is remote.',
    )
  }
  const names = Object.values(internals.userSchema)
    .filter(isTable)
    .map((table) => getTableName(table))
    .filter((name) => !INTERNAL_TABLE_NAMES.has(name))
    .sort()
  const mark = getTableName(bunderstackSeed)
  await inTransaction(internals, async (tx) => {
    const run = async (statement: string) => {
      const query = sql.raw(statement)
      const loose = tx as unknown as Loose
      // SQLite drivers run a statement; Postgres ones execute it.
      if (internals.dialect === 'pg') await loose.execute(query)
      else await loose.run(query)
    }
    if (internals.dialect === 'pg') {
      await run(
        `TRUNCATE TABLE ${[...names, mark].map(quote).join(', ')} RESTART IDENTITY CASCADE`,
      )
      return
    }
    // Rows reference each other in an order nobody wants to work out; the
    // checks wait for the commit, by when every table is empty.
    await run('PRAGMA defer_foreign_keys = ON')
    for (const name of [...names, mark]) await run(`DELETE FROM ${quote(name)}`)
  })
  return names
}
