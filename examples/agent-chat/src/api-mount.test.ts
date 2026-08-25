import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test('mounts the Bunderstack handler under the TanStack API catch-all', () => {
  const route = join(import.meta.dir, 'routes/api/$.tsx')

  expect(existsSync(route)).toBe(true)
  expect(readFileSync(route, 'utf8')).toContain('createApiHandlers(app)')
})
