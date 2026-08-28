import type {
  DatabaseAdapter,
  TestDatabaseStrategy,
  TestDatabaseTarget,
} from '../database/adapter'

export async function createTestDatabaseTarget(
  adapter: DatabaseAdapter,
  options: {
    mode: 'memory' | 'temporary'
    strategy?: TestDatabaseStrategy
  },
): Promise<TestDatabaseTarget> {
  const strategy = options.strategy ?? adapter.testing
  if (!strategy) {
    throw new Error(
      `[bunderstack] ${adapter.driver} requires an explicit test database strategy`,
    )
  }
  return strategy.createTarget({ mode: options.mode })
}
