// `bunderstack/seed`: how an application says what an empty database starts
// with. This module only declares; `seed-runtime.ts` decides when it runs.
import type { BunderstackBackend } from './backend'

const SEED: unique symbol = Symbol.for('bunderstack.seed')

/** The application a backend starts, as `backend.start()` resolves it. */
type AppOf<TBackend> =
  TBackend extends BunderstackBackend<infer TApp> ? TApp : never

/** The handle inside `db.transaction(...)` of the application's database. */
type TxOf<TApp> = TApp extends {
  db: {
    transaction(run: (tx: infer TTx, ...rest: never[]) => unknown): unknown
  }
}
  ? TTx
  : never

type SchemaOf<TApp> = TApp extends { $inferClient?: { schema: infer TSchema } }
  ? TSchema
  : never

/** What a seed is given. */
export type SeedContext<TBackend> = {
  /**
   * The application's database, inside the transaction the seed runs in.
   * Everything written through it is kept together with the mark that the
   * database is seeded, or not at all.
   */
  db: TxOf<AppOf<TBackend>>
  /** The application's tables, the same object the backend was given. */
  schema: SchemaOf<AppOf<TBackend>>
  /** The validated environment, as every other callback gets it. */
  env: AppOf<TBackend> extends { env: infer TEnv } ? TEnv : never
}

export type SeedDefinition = {
  readonly [SEED]: true
  run(context: unknown): void | Promise<void>
}

/**
 * Declares the data an empty database starts with.
 *
 * ```ts
 * // src/seed.ts
 * import { defineSeed } from 'bunderstack/seed'
 * import { backend } from './bunderstack'
 *
 * export default defineSeed(backend, async ({ db, schema }) => {
 *   const [ada] = await db
 *     .insert(schema.users)
 *     .values({ name: 'Ada', email: 'ada@example.com' })
 *     .returning()
 *   await db.insert(schema.orders).values({ userId: ada.id, total: 4200 })
 * })
 * ```
 *
 * The backend is passed for its types alone; nothing is started here. Name
 * the module in the backend as `database: { seed: () => import('./seed') }`.
 */
export function defineSeed<TBackend extends BunderstackBackend<any>>(
  _backend: TBackend,
  run: (context: SeedContext<TBackend>) => void | Promise<void>,
): SeedDefinition {
  if (typeof run !== 'function') {
    throw new Error('[bunderstack] defineSeed(backend, run) needs a function')
  }
  return { [SEED]: true, run: run as SeedDefinition['run'] }
}

export function isSeedDefinition(value: unknown): value is SeedDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [SEED]?: unknown })[SEED] === true
  )
}

/**
 * What `database.seed` resolved to: the definition itself, or a module whose
 * default export is one.
 */
export function seedFromModule(loaded: unknown): SeedDefinition {
  if (isSeedDefinition(loaded)) return loaded
  const exported = (loaded as { default?: unknown } | null)?.default
  if (isSeedDefinition(exported)) return exported
  throw new Error(
    '[bunderstack] database.seed must resolve to a module whose default export is defineSeed(...) from bunderstack/seed',
  )
}
