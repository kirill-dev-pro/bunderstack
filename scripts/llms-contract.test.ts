import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const llmsPath = join(root, 'packages/bunderstack/llms.txt')
const llms = readFileSync(llmsPath, 'utf8')

/**
 * `llms.txt` is the one document an agent reads instead of the site. It rots
 * silently — nothing imports it — so the contract below pins the parts that
 * would send an agent down a pattern we removed.
 */
describe('llms.txt contract', () => {
  test('ships with the package and is served by the site', () => {
    expect(existsSync(llmsPath)).toBe(true)

    const pkg = JSON.parse(
      readFileSync(join(root, 'packages/bunderstack/package.json'), 'utf8'),
    ) as { files: string[] }
    expect(pkg.files).toContain('llms.txt')

    const postbuild = readFileSync(
      join(root, 'website/scripts/postbuild.mjs'),
      'utf8',
    )
    expect(postbuild).toContain('llms.txt')
  })

  test('is plain text, not markdown', () => {
    expect(llms).not.toMatch(/^#{1,6} /m)
    expect(llms).not.toContain('```')
    expect(llms).not.toMatch(/^\s*\|.*\|\s*$/m)
  })

  test('teaches the current way to declare an API', () => {
    expect(llms).toContain('defineApi({ schema, env: envSchema })')
    expect(llms).toContain('bunderstack({ schema, database, api })')
    expect(llms).toContain('o.middleware(')
    expect(llms).toContain('middleware: [instrumentation]')
    expect(llms).toContain('peekSession()')
    expect(llms).toContain('errors.NOT_FOUND(')
    expect(llms).toContain('BunderstackError')
    expect(llms).toContain('listSpec(')
    expect(llms).toContain('BunderstackDb<typeof schema>')
  })

  test('names the mistakes that this API shape invites', () => {
    expect(llms).toContain('COMMON MISTAKES')
    expect(llms).toContain('procedure bag')
    expect(llms).toContain('os.$context')
    expect(llms).toContain('leaves generated CRUD unmeasured')
    expect(llms).toContain('never for authorization')
  })

  test('states which stacks are absent, so an agent stops guessing', () => {
    expect(llms).toContain('There is no Hono, no tRPC, and no Zod requirement')
  })

  test('does not teach removed or non-existent APIs', () => {
    expect(llms).not.toContain('createTRPCClient')
    expect(llms).not.toMatch(/new Hono|app\.router\b/)
    expect(llms).not.toMatch(/from ['"]zod['"]/)
    expect(llms).not.toContain('storageOptions')
    expect(llms).not.toContain('uploadRules')
    expect(llms).not.toContain('listProcedure')
    expect(llms).not.toContain('createRealtimeClient')
  })
})
