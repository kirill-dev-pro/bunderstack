import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import templatePackage from '../templates/tanstack-start-saas/package.json'

const root = join(import.meta.dir, '../templates/tanstack-start-saas')

test('SaaS template exposes the Bunderstack deployment contract', () => {
  expect(templatePackage.bunderstack.entry).toBe('src/bunderstack/index.ts')
  expect(templatePackage.scripts).toMatchObject({
    dev: 'bun --bun vite dev',
    typecheck: 'tsc --noEmit',
    blueprint: 'bun ../../packages/bunderstack/src/cli.ts blueprint',
    'blueprint:check':
      'bun ../../packages/bunderstack/src/cli.ts blueprint --check',
  })
})

test('SaaS template contains all required routes and deployment files', () => {
  const files = [
    'src/bunderstack/index.ts',
    'src/routes/api/$.tsx',
    '.env.example',
    'README.md',
    'bunderstack.blueprint.yaml',
    'src/routes/index.tsx',
    'src/routes/app/route.tsx',
    'src/routes/app/index.tsx',
    'src/routes/admin/route.tsx',
    'src/routes/admin/index.tsx',
  ]

  for (const file of files) {
    expect(existsSync(join(root, file))).toBe(true)
  }
})

test('SaaS template README documents setup commands', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf-8')
  expect(readme).toContain('bun install')
  expect(readme).toContain('bun run dev')
  expect(readme).toContain('bun run db:generate')
  expect(readme).toContain('bun run blueprint:check')
})
