import { expect, test } from 'bun:test'
import templatePackage from '../templates/tanstack-start-saas/package.json'

test('SaaS template exposes the Bunderstack deployment contract', () => {
  expect(templatePackage.bunderstack.entry).toBe('src/bunderstack/index.ts')
  expect(templatePackage.scripts).toMatchObject({
    dev: 'bun --bun vite dev',
    worker: 'bun src/worker.ts',
    typecheck: 'tsc --noEmit',
    blueprint: 'bun ../../packages/bunderstack/src/cli.ts blueprint',
    'blueprint:check':
      'bun ../../packages/bunderstack/src/cli.ts blueprint --check',
  })
})
