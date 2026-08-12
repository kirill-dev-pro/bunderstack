import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const docsDir = join(root, 'website/content/docs')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const publicDocs = readdirSync(docsDir)
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => readFileSync(join(docsDir, file), 'utf8'))
  .join('\n')

describe('public website contract', () => {
  test('documents the unified oRPC procedure graph', () => {
    expect(existsSync(join(docsDir, 'api-procedures.mdx'))).toBe(true)
    expect(existsSync(join(docsDir, 'http-webhooks.mdx'))).toBe(true)
    expect(existsSync(join(docsDir, 'trpc.mdx'))).toBe(false)
    expect(existsSync(join(docsDir, 'custom-routes.mdx'))).toBe(false)

    expect(publicDocs).toContain('api: (o)')
    expect(publicDocs).toContain('o.protected')
    expect(publicDocs).toContain('o.webhook')
    expect(publicDocs).toContain('Standard Schema')
    expect(publicDocs).toContain('output validation')
  })

  test('describes realtime as a reliable library transport', () => {
    const realtime = read('website/content/docs/sync-collections.mdx')

    expect(realtime).toContain('oRPC Publisher')
    expect(realtime).toContain('heartbeat')
    expect(realtime).toContain('exponential backoff')
    expect(realtime).toContain('canonical row')
    expect(realtime).toContain('without a follow-up list request')
  })

  test('does not teach removed extension systems', () => {
    expect(publicDocs).not.toMatch(/\btRPC\b|api\.trpc|createTRPCClient/)
    expect(publicDocs).not.toMatch(
      /new Hono|BunderstackRouteContext|app\.router/,
    )
    expect(publicDocs).not.toMatch(/\bSSE\b|createRealtimeClient/)
    expect(publicDocs).not.toMatch(/from ['"]zod['"]|ZodType/)
  })

  test('navigation follows the primary learning path', () => {
    const meta = read('website/content/docs/meta.json')
    const pages = JSON.parse(meta).pages as string[]

    expect(pages.slice(0, 7)).toEqual([
      'index',
      'getting-started',
      'crud',
      'api-procedures',
      'query-client',
      'sync-collections',
      'http-webhooks',
    ])
    expect(pages).not.toContain('trpc')
    expect(pages).not.toContain('custom-routes')
  })

  test('landing uses the focused architectural blueprint story', () => {
    const landing = read('website/src/routes/index.tsx')
    const snippets = read('website/scripts/gen-code-snippets.ts')

    expect(landing).toContain('system-trace')
    expect(landing).toContain('type-trace')
    expect(landing).toContain('One graph. Every boundary typed.')
    expect(landing).toContain('prefers-reduced-motion')
    expect(snippets).toContain('procedure:')
    expect(snippets).toContain('client:')
    expect(snippets).toContain('realtime:')
    expect(snippets).not.toContain('trpc:')
  })

  test('docs deserialization cannot mutate router loader data', () => {
    const route = read('website/src/routes/docs/$.tsx')

    expect(route).toContain('structuredClone(serialized)')
    expect(route).toContain('useFumadocsLoader(deserializationCopy)')
  })

  test('mobile blueprint width uses valid CSS math', () => {
    const css = read('website/src/styles/app.css')

    expect(css).toContain('width: min(calc(100% - 26px), 1180px)')
    expect(css).not.toContain('width: min(100% - 26px, 1180px)')
  })
})
