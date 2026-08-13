// src/email.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'

import { libsql } from './database/libsql'
import { createDb } from './db'
import { createEmail, emailProviderTag } from './email'
import { bunderstackEmails, withInternalTables } from './internal-tables'
import { provisionSchema } from './provision'

const devEnv = { NODE_ENV: 'test' }
const schema = withInternalTables({})
const connection = await createDb(schema, {
  adapter: libsql(),
  dialect: 'sqlite',
  url: ':memory:',
})
const db = connection.db

beforeAll(async () => {
  await provisionSchema(db, schema)
})

test('unconfigured email throws a clear error on send', async () => {
  const email = createEmail(undefined, { env: devEnv })
  expect(email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })).rejects.toThrow(
    /email is not configured/,
  )
})

test('console provider is the dev default and logs instead of sending', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv, db })
  const result = await email.send({ to: 'a@b.c', subject: 'hi', text: 'body' })
  expect(result.id).toStartWith('email_')
  const id = result.id!
  const [row] = await db
    .select()
    .from(bunderstackEmails)
    .where(eq(bunderstackEmails.id, id))
  expect(row).toMatchObject({ provider: 'capture', status: 'captured' })
})

test('unset provider in production captures instead of failing boot', async () => {
  const email = createEmail(
    { from: 'app@example.com' },
    { env: { NODE_ENV: 'production' }, db },
  )
  const result = await email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })
  const id = result.id!
  const [row] = await db
    .select()
    .from(bunderstackEmails)
    .where(eq(bunderstackEmails.id, id))
  expect(row!.status).toBe('captured')
})

test('message must have html or text', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv, db })
  expect(email.send({ to: 'a@b.c', subject: 'hi' })).rejects.toThrow(
    /html or text/,
  )
})

test('resend provider posts to the resend API with from default', async () => {
  let captured: { url: string; init: RequestInit } | undefined
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    captured = { url: String(url), init: init! }
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
  }) as typeof fetch
  const email = createEmail(
    { from: 'app@example.com', provider: 'resend' },
    {
      env: {
        ...devEnv,
        RESEND_API_KEY: 're_test',
        BUNDERHOST_ENVIRONMENT_ID: 'env_preview',
      },
      fetchFn,
      db,
    },
  )
  const result = await email.send({
    to: 'a@b.c',
    subject: 'hi',
    html: '<b>x</b>',
  })
  expect(result.id).toStartWith('email_')
  const id = result.id!
  expect(result.providerId).toBe('email_123')
  expect(captured!.url).toBe('https://api.resend.com/emails')
  expect(captured!.init.headers).toMatchObject({
    Authorization: 'Bearer re_test',
    'Content-Type': 'application/json',
  })
  const body = JSON.parse(String(captured!.init.body))
  expect(body.from).toBe('app@example.com')
  expect(body.to).toEqual(['a@b.c'])
  expect(body.tags).toContainEqual({
    name: 'bunderstack_email_id',
    value: id,
  })
  expect(body.tags).toContainEqual({
    name: 'bunderhost_environment_id',
    value: 'env_preview',
  })
  const [row] = await db
    .select()
    .from(bunderstackEmails)
    .where(eq(bunderstackEmails.id, id))
  expect(row).toMatchObject({
    provider: 'resend',
    providerId: 'email_123',
    status: 'sent',
  })
})

test('resend provider surfaces API errors', async () => {
  const fetchFn = (async () =>
    new Response('{"message":"invalid"}', {
      status: 422,
    })) as unknown as typeof fetch
  const email = createEmail(
    { from: 'app@example.com', provider: 'resend' },
    { env: { ...devEnv, RESEND_API_KEY: 're_test' }, fetchFn, db },
  )
  expect(email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })).rejects.toThrow(
    /resend/i,
  )
})

test('custom adapter object is used as-is', async () => {
  const sent: unknown[] = []
  const email = createEmail(
    {
      from: 'app@example.com',
      provider: {
        send: async (msg) => {
          sent.push(msg)
          return { id: 'custom-1' }
        },
      },
    },
    { env: devEnv, db },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.id).toStartWith('email_')
  expect(result.providerId).toBe('custom-1')
  expect((sent[0] as { from: string }).from).toBe('app@example.com')
})

test('bare function provider works', async () => {
  const email = createEmail(
    { from: 'app@example.com', provider: async () => ({ id: 'fn-1' }) },
    { env: devEnv, db },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.providerId).toBe('fn-1')
})

test('Bunderhost Resend env overrides capture provider', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ id: 'managed-1' }), {
      status: 200,
    })) as unknown as typeof fetch
  const email = createEmail(
    { from: 'source@example.com' },
    {
      env: {
        ...devEnv,
        BUNDERSTACK_EMAIL_PROVIDER: 'resend',
        BUNDERSTACK_EMAIL_FROM: 'managed@example.com',
        RESEND_API_KEY: 're_managed',
      },
      fetchFn,
      db,
    },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  const id = result.id!
  const [row] = await db
    .select()
    .from(bunderstackEmails)
    .where(eq(bunderstackEmails.id, id))
  expect(row).toMatchObject({
    from: 'managed@example.com',
    provider: 'resend',
    providerId: 'managed-1',
  })
})

test('string provider smtp throws a migration error', () => {
  expect(() =>
    createEmail(
      // @ts-expect-error smtp was removed from the type
      { from: 'app@example.com', provider: 'smtp' },
      { env: devEnv },
    ),
  ).toThrow(/was removed/)
})

test('emailProviderTag extracts string providers only', () => {
  expect(emailProviderTag({ from: 'a@b.c', provider: 'resend' })).toBe('resend')
  expect(
    emailProviderTag({ from: 'a@b.c', provider: async () => ({}) }),
  ).toBeUndefined()
  expect(emailProviderTag(undefined)).toBeUndefined()
})
