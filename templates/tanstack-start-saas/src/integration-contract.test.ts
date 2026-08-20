import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Task 3 integration contract', () => {
  it('api route handlers use createApiHandlers(app)', () => {
    const content = readFileSync(
      join(import.meta.dir, 'routes/api/$.tsx'),
      'utf-8',
    )
    expect(content).toContain('createApiHandlers(app)')
  })

  it('api client builds on the unified oRPC client', () => {
    const content = readFileSync(join(import.meta.dir, 'api.ts'), 'utf-8')
    expect(content).toContain('createClient<App>(')
    expect(content).toContain('createIsomorphicFetch()')
  })

  it('auth client imports from bunderstack-start/auth', () => {
    const content = readFileSync(
      join(import.meta.dir, 'lib/auth-client.ts'),
      'utf-8',
    )
    expect(content).toContain('bunderstack-start/auth')
  })
})
