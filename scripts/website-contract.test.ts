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

    expect(publicDocs).toContain('o.protected')
    expect(publicDocs).toContain('o.webhook')
    expect(publicDocs).toContain('Standard Schema')
    expect(publicDocs).toContain('output validation')
  })

  test('teaches the module-scope declaration, not the callback', () => {
    const procedures = read('website/content/docs/api-procedures.mdx')

    // The builder is a module value, so router modules are plain objects.
    expect(procedures).toContain('defineApi({ schema, env: envSchema })')
    expect(procedures).toContain('export const boardsRouter = {')
    expect(procedures).toContain('createBunderstack({ schema, database, api })')

    // The callback stays supported, but only as the exception.
    expect(procedures).toContain('api: (o) => ({ … })')
  })

  test('documents how to extend bases and raise typed errors', () => {
    const procedures = read('website/content/docs/api-procedures.mdx')

    expect(procedures).toContain('o.protected.use(')
    expect(procedures).toContain('next({ context:')
    expect(procedures).toContain('errors.NOT_FOUND(')
    expect(procedures).toContain('BunderstackError')
    expect(procedures).toContain('listSpec(')
    expect(procedures).toContain('BunderstackDb')
  })

  test('separates per-base middleware from graph-wide middleware', () => {
    expect(existsSync(join(docsDir, 'middleware.mdx'))).toBe(true)
    const middleware = read('website/content/docs/middleware.mdx')

    // The gap this option closes: generated procedures skip application bases.
    expect(middleware).toContain('never pass through a base your application')
    expect(middleware).toContain('middleware: [instrumentation]')
    expect(middleware).toContain('o.middleware(')

    // peekSession is the only safe way to read the caller there.
    expect(middleware).toContain('peekSession()')
    expect(middleware).toContain('Never use it for authorization')
    expect(middleware).toContain('runs when the stream closes')
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

    expect(pages.slice(0, 8)).toEqual([
      'index',
      'getting-started',
      'crud',
      'api-procedures',
      'middleware',
      'query-client',
      'sync-collections',
      'http-webhooks',
    ])
    expect(pages).not.toContain('trpc')
    expect(pages).not.toContain('custom-routes')
  })

  test('landing leads with the single-file declaration story', () => {
    const landing = read('website/src/routes/index.tsx')
    const snippets = read('website/scripts/gen-code-snippets.ts')

    expect(landing).toContain('system-trace')
    expect(landing).toContain('type-trace')
    expect(landing).toContain('prefers-reduced-motion')
    expect(landing).toContain('Your whole backend as a single file declaration.')
    // The value the library sells, in the order the page argues it. The typed
    // graph is what makes these possible, not the headline claim itself.
    expect(landing).toContain('A / Declare')
    expect(landing).toContain('B / Run')
    expect(landing).toContain('C / Context')
    expect(landing).not.toContain('One graph. Every boundary typed.')
    expect(snippets).toContain('declaration:')
    expect(snippets).toContain('procedure:')
    expect(snippets).toContain('client:')
    expect(snippets).toContain('realtime:')
    expect(snippets).not.toContain('trpc:')
  })

  test('the landing and README make the same promise', () => {
    const landing = read('website/src/routes/index.tsx')
    const readme = read('README.md')

    expect(readme).toContain('single file declaration')
    // One measured claim, quoted in two places; they must not drift apart.
    expect(landing).toContain('439 lines')
    expect(readme).toContain('439 lines')
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
