import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from './database/libsql'
import { bunderstack } from './index'

const notes = sqliteTable('auth_free_notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

/**
 * better-auth signs its session cookie as `<token>.<base64 hmac>`. A browser
 * keeps that cookie per host, not per port, so a session minted by another
 * localhost app on a different port reaches this app too.
 */
async function staleSessionCookie(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const token = 'session-token-from-another-app'
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(token),
  )
  const value = `${token}.${Buffer.from(signature).toString('base64')}`
  return `better-auth.session_token=${value}`
}

test('an app that declares no auth models ignores a stale session cookie', async () => {
  const backend = bunderstack({
    schema: { notes },
    access: { notes: { crud: true, list: 'public' } },
    database: { adapter: libsql() },
  })
  await using fixture = await backend.test({ database: { schema: 'push' } })

  const response = await fixture.app.handler(
    new Request('http://localhost/api/rpc/notes/list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: await staleSessionCookie('bunderstack-test-secret'),
      },
      body: JSON.stringify({ json: {} }),
    }),
  )

  expect(response.status).toBe(200)
})

/**
 * better-auth 1.7.6 checks the drizzle schema before every `auth.api` call and
 * throws on missing tables. An app without auth models must never reach it —
 * not through the OpenAPI spec, not through `/api/auth/*`.
 */
test('an app that declares no auth models serves OpenAPI and requests', async () => {
  const backend = bunderstack({
    schema: { notes },
    access: { notes: { crud: true, list: 'public' } },
    database: { adapter: libsql() },
    openapi: true,
  })
  await using fixture = await backend.test({ database: { schema: 'push' } })

  const list = await fixture.app.handler(
    new Request('http://localhost/api/rpc/notes/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    }),
  )
  expect(list.status).toBe(200)

  const spec = await fixture.app.handler(
    new Request('http://localhost/api/openapi.json'),
  )
  expect(spec.status).toBe(200)
  const { paths } = (await spec.json()) as { paths: Record<string, unknown> }
  expect(
    Object.keys(paths).filter((path) => path.startsWith('/api/auth/')),
  ).toEqual([])

  const session = await fixture.app.handler(
    new Request('http://localhost/api/auth/get-session'),
  )
  expect(session.status).toBe(404)
})

test('declaring auth without its models warns at startup', async () => {
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    auth: { emailAndPassword: { enabled: true } },
  })
  await using fixture = await backend.test({ database: { schema: 'push' } })
  expect(fixture.app).toBeDefined()
  const warnings = fixture.logs.warnings
    .map((entry) => entry.message)
    .join('\n')

  expect(warnings).toContain('missing better-auth tables: `user`, `session`')
})
