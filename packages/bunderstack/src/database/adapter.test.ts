import { describe, expect, test } from 'bun:test'

import type { DatabaseAdapter } from './adapter'

describe('DatabaseAdapter', () => {
  test('is structural and carries an explicit dialect and driver', async () => {
    const adapter: DatabaseAdapter = {
      dialect: 'sqlite',
      driver: 'libsql',
      connect: async () => ({ isDb: true }) as any,
      migrate: async () => {},
    }

    expect(adapter.dialect).toBe('sqlite')
    expect(adapter.driver).toBe('libsql')
    expect(await adapter.connect({}, { url: 'file:test.db' })).toEqual({
      isDb: true,
    } as any)
  })
})
