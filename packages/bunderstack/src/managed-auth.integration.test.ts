import { betterAuth } from 'better-auth'
import { genericOAuth } from 'better-auth/plugins'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { withManagedIdentity } from './auth'
import { validateEnv, createClientEnv } from './env'
import { buildManifest } from './manifest'
import { createStartAuthClient } from './start/auth-client'
import { resolveBuckets } from './storage/buckets'
const schema = { user: {}, session: {}, account: {}, verification: {} }
const env = {
  APP_URL: 'https://app.example.com',
  BUNDERHOST_AUTH_CONFIG: JSON.stringify({
    version: 2,
    issuer: 'https://auth.example.com',
    clientId: 'client',
    clientSecret: 's'.repeat(40),
    revision: 1,
  }),
}
test('managed identity installs from reserved server env and preserves custom plugins', () => {
  const cfg = withManagedIdentity({ plugins: [{ id: 'custom' }] }, env, schema)
  expect(cfg.plugins?.map((p) => p.id)).toEqual([
    'custom',
    'bunderhost-managed-status',
    'generic-oauth',
  ])
  expect(
    withManagedIdentity({ managedIdentity: false }, env, schema).plugins,
  ).toBeUndefined()
  expect(withManagedIdentity({}, env, {}).plugins).toBeUndefined()
  expect(withManagedIdentity({}, {}, schema).plugins).toBeUndefined()
  expect(validateEnv(undefined, { source: env }).BUNDERHOST_AUTH_CONFIG).toBe(
    env.BUNDERHOST_AUTH_CONFIG,
  )
  expect(
    () =>
      (createClientEnv({}) as Record<string, unknown>).BUNDERHOST_AUTH_CONFIG,
  ).toThrow('server-only')
})
test('blueprint capability and reserved env only appear for actual auth schema', () => {
  // Empty table placeholders do not count as database tables; this isolates
  // capability generation from schema description without provisioning a DB.
  const args = {
    schema: {},
    dialect: 'sqlite' as const,
    migrationsDirectory: './migrations',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    messaging: undefined,
    realtime: false,
    jobs: undefined,
    api: [],
  }
  expect(buildManifest(args).authentication).toBeUndefined()
  const tables = Object.fromEntries(
    ['user', 'session', 'account', 'verification'].map((name) => [
      name,
      sqliteTable(name, { id: text('id').primaryKey() }),
    ]),
  )
  const manifest = buildManifest({ ...args, schema: tables })
  expect(manifest.authentication?.managedIdentity.adapterVersion).toBe(2)
  expect(
    manifest.environment.find((e) => e.key === 'BUNDERHOST_AUTH_CONFIG'),
  ).toEqual({
    key: 'BUNDERHOST_AUTH_CONFIG',
    scope: 'server',
    sensitive: true,
    required: false,
  })
  expect(
    buildManifest({ ...args, schema: tables, auth: { managedIdentity: false } })
      .authentication,
  ).toBeUndefined()
})
test('browser client exposes the managed helpers without server SDK imports', () => {
  const client = createStartAuthClient({ baseURL: 'https://app.example.com' })
  expect(typeof client.managed.providers).toBe('function')
  expect(typeof client.signIn.managed).toBe('function')
})

test('managed signIn uses the managed endpoint instead of a Better Auth inferred route', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({
      url: 'https://auth.example.com/login',
      redirect: false,
    })
  }) as unknown as typeof fetch
  try {
    const client = createStartAuthClient({ baseURL: 'https://app.example.com' })
    await client.signIn.managed({ provider: 'github', callbackURL: '/profile' })
    expect(requests).toEqual([
      'https://app.example.com/api/auth/managed/sign-in',
    ])
  } finally {
    globalThis.fetch = original
  }
})

test('a custom bunderhost provider cannot overwrite managed identity', async () => {
  const plugins = [
    genericOAuth({
      config: [
        {
          providerId: 'bunderhost',
          clientId: 'custom',
          clientSecret: 'custom',
          authorizationUrl: 'https://custom.example.com/authorize',
          tokenUrl: 'https://custom.example.com/token',
          userInfoUrl: 'https://custom.example.com/user',
        },
      ],
    }),
  ]
  expect(() => withManagedIdentity({ plugins }, env, schema)).toThrow(
    'reserved for managed identity',
  )
})

test('Better Auth 1.7 starts provider-bound managed OAuth with cookies', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      revision: 1,
      enabled: true,
      providers: [{ id: 'github', label: 'GitHub', availability: 'ready' }],
    })) as unknown as typeof fetch
  try {
    const cfg = withManagedIdentity(
      {
        secret: 's'.repeat(40),
        baseURL: env.APP_URL,
        logger: { disabled: true },
      },
      env,
      schema,
    )
    const auth = betterAuth(cfg)
    const response = await auth.handler(
      new Request(env.APP_URL + '/api/auth/managed/sign-in', {
        method: 'POST',
        headers: { origin: env.APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: '/profile' }),
      }),
    )
    expect(response.status).toBe(200)
    const url = new URL((await response.json()).url)
    expect(url.searchParams.get('bunderhost_provider')).toBe('github')
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0)
  } finally {
    globalThis.fetch = original
  }
})

test('client declarations cannot expose managed credentials through serialization', () => {
  expect(() =>
    createClientEnv({
      client: { BUNDERHOST_AUTH_CONFIG: v.string() },
      runtimeEnv: env,
    }),
  ).toThrow('server-only')
  expect(JSON.stringify(createClientEnv({ runtimeEnv: env }))).not.toContain(
    env.BUNDERHOST_AUTH_CONFIG,
  )
})
