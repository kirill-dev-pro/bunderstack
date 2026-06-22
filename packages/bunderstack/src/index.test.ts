import { describe, it, expect } from 'bun:test'

describe('imports', () => {
  it('should import all dependencies without errors', async () => {
    // Test that all packages can be imported
    const hono = await import('hono')
    const drizzle = await import('drizzle-orm')
    const libsql = await import('@libsql/client')
    const auth = await import('better-auth')
    const zod = await import('zod')

    expect(hono).toBeDefined()
    expect(drizzle).toBeDefined()
    expect(libsql).toBeDefined()
    expect(auth).toBeDefined()
    expect(typeof Bun.Image).toBe('function')
    expect(zod).toBeDefined()
  })
})
