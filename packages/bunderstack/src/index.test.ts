import { describe, it, expect } from 'bun:test'

describe('imports', () => {
  it('should import all dependencies without errors', async () => {
    // Test that all packages can be imported
    const drizzle = await import('drizzle-orm')
    const libsql = await import('@libsql/client')
    const auth = await import('better-auth')
    const valibot = await import('valibot')

    expect(drizzle).toBeDefined()
    expect(libsql).toBeDefined()
    expect(auth).toBeDefined()
    expect(typeof Bun.Image).toBe('function')
    expect(valibot).toBeDefined()
  })
})
