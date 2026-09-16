import { describe, expect, it } from 'bun:test'

// Isolate the optional TanStack peer and environment variables from other tests.
const probe = `
  import { mock } from 'bun:test'
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: () => {
      if (!process.env.SSR_TEST_REQUEST_URL) throw new Error('No request context')
      return new Request(process.env.SSR_TEST_REQUEST_URL)
    },
  }))
  const { createIsomorphicFetch } = await import(${JSON.stringify(new URL('./isomorphic-fetch.ts', import.meta.url).href)})
  if (process.env.SSR_TEST_BROWSER === 'true') globalThis.window = {}
  const transport = async (input, init) => {
    const target = String(input)
    const status = target.startsWith('http://airealty.global/') ? 308 : 200
    return Response.json({ target, method: init.method, redirect: init.redirect }, { status })
  }
  const result = await createIsomorphicFetch({ fetch: transport })(
    process.env.SSR_TEST_INPUT_URL,
    { method: 'POST', redirect: 'manual' },
  )
  process.stdout.write(JSON.stringify({ status: result.status, ...await result.json() }))
`

const runProbe = async (settings: {
  appUrl?: string
  requestUrl?: string
  authUrl?: string
  browser?: boolean
  input?: string
}) => {
  const child = Bun.spawn([process.execPath, '-e', probe], {
    env: {
      ...process.env,
      APP_URL: settings.appUrl,
      BETTER_AUTH_URL: settings.authUrl,
      SSR_TEST_REQUEST_URL: settings.requestUrl,
      SSR_TEST_BROWSER: String(settings.browser ?? false),
      SSR_TEST_INPUT_URL: settings.input ?? '/api/rpc/agents/getBySlug',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(errors).toBe('')
  return JSON.parse(output) as {
    status: number
    target: string
    method: string
    redirect: string
  }
}

describe('createIsomorphicFetch origin selection', () => {
  it('uses the configured HTTPS APP_URL behind an HTTP reverse proxy', async () => {
    expect(
      await runProbe({
        appUrl: 'https://airealty.global',
        requestUrl: 'http://airealty.global/profile',
      }),
    ).toEqual({
      status: 200,
      target: 'https://airealty.global/api/rpc/agents/getBySlug',
      method: 'POST',
      redirect: 'manual',
    })
  })

  it('uses the incoming request origin when APP_URL is absent', async () => {
    const result = await runProbe({
      requestUrl: 'http://localhost:3001/profile',
      authUrl: 'https://auth.example.com',
    })
    expect(result.target).toBe('http://localhost:3001/api/rpc/agents/getBySlug')
  })

  it('uses BETTER_AUTH_URL outside a request when APP_URL is absent', async () => {
    const result = await runProbe({ authUrl: 'https://auth.example.com' })
    expect(result.target).toBe(
      'https://auth.example.com/api/rpc/agents/getBySlug',
    )
  })

  it('retains the localhost default without environment or request context', async () => {
    const result = await runProbe({})
    expect(result.target).toBe('http://localhost:3000/api/rpc/agents/getBySlug')
  })

  it('passes relative URLs through unchanged in the browser', async () => {
    const result = await runProbe({
      appUrl: 'https://airealty.global',
      browser: true,
    })
    expect(result.target).toBe('/api/rpc/agents/getBySlug')
  })

  it('does not rewrite absolute URLs', async () => {
    const result = await runProbe({
      appUrl: 'https://airealty.global',
      input: 'https://other.example.com/api',
    })
    expect(result.target).toBe('https://other.example.com/api')
  })
})
