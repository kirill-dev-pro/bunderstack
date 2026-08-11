import { expect, test } from 'bun:test'

import { createApiBuilder } from './builder'
import { buildApiRouter } from './router'

test('builds health into the same graph and rejects duplicate handles', () => {
  const router = buildApiRouter({ crud: {}, storage: {} })
  expect(router.health).toBeDefined()

  const builder = createApiBuilder()
  const duplicate = builder.public.handler(() => ({ status: 'custom' }))
  expect(() =>
    buildApiRouter({
      crud: {},
      storage: {},
      custom: { health: duplicate },
    }),
  ).toThrow(/health/)
})
