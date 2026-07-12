// src/email.test.ts
import { test, expect } from 'bun:test'

import { createEmail, emailProviderTag } from './email'

const devEnv = { NODE_ENV: 'test' }

test('unconfigured email throws a clear error on send', async () => {
  const email = createEmail(undefined, { env: devEnv })
  expect(email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })).rejects.toThrow(
    /email is not configured/,
  )
})

test('console provider is the dev default and logs instead of sending', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv })
  const result = await email.send({ to: 'a@b.c', subject: 'hi', text: 'body' })
  expect(result).toEqual({})
})

test('unset provider in production is a boot error', () => {
  expect(() =>
    createEmail(
      { from: 'app@example.com' },
      { env: { NODE_ENV: 'production' } },
    ),
  ).toThrow(/provider/)
})

test('message must have html or text', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv })
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
    { env: { ...devEnv, RESEND_API_KEY: 're_test' }, fetchFn },
  )
  const result = await email.send({
    to: 'a@b.c',
    subject: 'hi',
    html: '<b>x</b>',
  })
  expect(result.id).toBe('email_123')
  expect(captured!.url).toBe('https://api.resend.com/emails')
  expect(captured!.init.headers).toMatchObject({
    Authorization: 'Bearer re_test',
    'Content-Type': 'application/json',
  })
  const body = JSON.parse(String(captured!.init.body))
  expect(body.from).toBe('app@example.com')
  expect(body.to).toEqual(['a@b.c'])
})

test('resend provider surfaces API errors', async () => {
  const fetchFn = (async () =>
    new Response('{"message":"invalid"}', { status: 422 })) as typeof fetch
  const email = createEmail(
    { from: 'app@example.com', provider: 'resend' },
    { env: { ...devEnv, RESEND_API_KEY: 're_test' }, fetchFn },
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
    { env: devEnv },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.id).toBe('custom-1')
  expect((sent[0] as { from: string }).from).toBe('app@example.com')
})

test('bare function provider works', async () => {
  const email = createEmail(
    { from: 'app@example.com', provider: async () => ({ id: 'fn-1' }) },
    { env: devEnv },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.id).toBe('fn-1')
})

test('smtp provider without nodemailer installed is a boot error', () => {
  expect(() =>
    createEmail(
      { from: 'app@example.com', provider: 'smtp' },
      {
        env: { ...devEnv, SMTP_URL: 'smtp://localhost' },
        canResolveModule: () => false,
      },
    ),
  ).toThrow(/nodemailer/)
})

test('emailProviderTag extracts string providers only', () => {
  expect(emailProviderTag({ from: 'a@b.c', provider: 'resend' })).toBe(
    'resend',
  )
  expect(
    emailProviderTag({ from: 'a@b.c', provider: async () => ({}) }),
  ).toBeUndefined()
  expect(emailProviderTag(undefined)).toBeUndefined()
})
