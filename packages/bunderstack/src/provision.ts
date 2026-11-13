import { applyCommittedMigrations } from './provision-runtime'
import { seedIfAsked } from './seed-runtime'

const MIGRATIONS_REQUIRED =
  '[bunderstack] No committed migrations journal was found.\n' +
  '  Production: generate migrations with `bunx drizzle-kit generate`, commit them, and keep using `bunderstack/provision`.\n' +
  '  Development schema push: import provision from `bunderstack/provision-schema`.'

/**
 * Apply committed migrations for a Bunderstack app.
 *
 * This production entrypoint has no Drizzle Kit dependency. Development
 * schema push is deliberately isolated in `bunderstack/provision-schema`.
 *
 * With the schema in place, an application that declares `database.seed` is
 * seeded here when the process was started with `BUNDERSTACK_SEED=1` and the
 * database has not been seeded before.
 */
export async function provision(app: object): Promise<void> {
  if (!(await applyCommittedMigrations(app))) {
    throw new Error(MIGRATIONS_REQUIRED)
  }
  // Only a process started with BUNDERSTACK_SEED=1 seeds, and only a
  // database that has not been seeded.
  await seedIfAsked(app)
}
