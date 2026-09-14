import { applyCommittedMigrations } from './provision-runtime'

const MIGRATIONS_REQUIRED =
  '[bunderstack] No committed migrations journal was found.\n' +
  '  Production: generate migrations with `bunx drizzle-kit generate`, commit them, and keep using `bunderstack/provision`.\n' +
  '  Development schema push: import provision from `bunderstack/provision-schema`.'

/**
 * Apply committed migrations for a Bunderstack app.
 *
 * This production entrypoint has no Drizzle Kit dependency. Development
 * schema push is deliberately isolated in `bunderstack/provision-schema`.
 */
export async function provision(app: object): Promise<void> {
  if (!(await applyCommittedMigrations(app))) {
    throw new Error(MIGRATIONS_REQUIRED)
  }
}
