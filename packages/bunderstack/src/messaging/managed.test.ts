import { beforeEach, expect, mock, spyOn, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackMessages, INTERNAL_TABLES } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { email, EMAIL_PROVIDERS } from './email'
import { createMessaging, receivingFor } from './runtime'

const env = {
  DATABASE_URL: ':memory:',
  AUTH_SECRET: 'test',
  BUNDERSTACK_ROLE: 'web' as const,
  BUNDERHOST_ENVIRONMENT_ID: 'env_1',
}

const credentials = {
  resend: { apiKey: 're_managed' },
  ses: {
    region: 'eu-west-1',
    accessKeyId: 'AKIDMANAGED',
    secretAccessKey: 'managed-secret',
    inbound: { secret: 's', channels: { inbox: ['mail.shop.example'] } },
  },
}

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']

beforeEach(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
})

function fetchSpy() {
  const urls: string[] = []
  const fetchFn = mock(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      urls.push(input instanceof Request ? input.url : String(input))
      return Response.json({
        id: `sent_${urls.length}`,
        MessageId: `ses_${urls.length}`,
      })
    },
  )
  return { urls, fetchFn }
}

function messagingFor(choice: Record<string, unknown> | undefined) {
  const { urls, fetchFn } = fetchSpy()
  const messaging = createMessaging(
    { email: email({ from: 'Shop <orders@shop.example>' }) },
    {
      db: db as never,
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          ...credentials,
          ...(choice ? { email: choice } : {}),
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  return { messaging, urls }
}

const message = { to: 'ana@customer.example', subject: 'Order', text: 'Hi' }

test('email() is a managed email descriptor', () => {
  const descriptor = email({ from: 'a@shop.example' })
  expect(descriptor.kind).toBe('email')
  expect(descriptor.provider).toBe('managed')
  expect(EMAIL_PROVIDERS).toEqual(['ses', 'resend'])
})

test('a managed channel sends through the provider the host chose', async () => {
  for (const [send, host] of [
    ['resend', 'api.resend.com'],
    ['ses', 'email.eu-west-1.amazonaws.com'],
  ] as const) {
    const { messaging, urls } = messagingFor({ send })
    await messaging.email.send(message)
    expect(new URL(urls[0]!).host).toBe(host)
  }
  const rows = await db.select().from(bunderstackMessages)
  expect(
    rows.map((row) => [row.provider, row.credentialSource]).sort(),
  ).toEqual([
    ['resend', 'managed'],
    ['ses', 'managed'],
  ])
})

test('a managed channel captures when the host chose nothing', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const { messaging, urls } = messagingFor(undefined)
    await messaging.email.send(message)
    expect(urls).toEqual([])
    const [row] = await db.select().from(bunderstackMessages)
    expect(row).toMatchObject({
      provider: 'managed',
      status: 'captured',
      credentialSource: 'capture',
    })
  } finally {
    log.mockRestore()
  }
})

test('a chosen provider without credentials captures', async () => {
  const { fetchFn } = fetchSpy()
  const messaging = createMessaging(
    { email: email({ from: 'orders@shop.example' }) },
    {
      db: db as never,
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          email: { send: 'resend' },
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  await messaging.email.send(message)
  expect(fetchFn).not.toHaveBeenCalled()
  const [row] = await db.select().from(bunderstackMessages)
  expect(row).toMatchObject({ provider: 'resend', status: 'captured' })
})

test('a provider this version does not know fails at boot', () => {
  expect(() => messagingFor({ send: 'postmark' })).toThrow(
    /routes email to "postmark".*upgrade bunderstack/,
  )
})

test('receiving follows email.receive, independent of sending', () => {
  const descriptor = email({ receive: true })
  const managed = { ...credentials, email: { send: 'resend', receive: 'ses' } }
  expect(receivingFor('inbox', descriptor, managed)).toEqual({
    provider: 'ses',
    secret: 's',
    domains: ['mail.shop.example'],
  })
  // Without email.receive, receiving uses the sending provider, which here
  // has no inbound block.
  expect(
    receivingFor('inbox', descriptor, {
      ...credentials,
      email: { send: 'resend' },
    }),
  ).toEqual({ provider: 'resend', secret: undefined, domains: [] })
})

test('pinned channels ignore the host choice', async () => {
  const { resend } = await import('./email')
  const { urls, fetchFn } = fetchSpy()
  const messaging = createMessaging(
    { email: resend({ from: 'orders@shop.example' }) },
    {
      db: db as never,
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          ...credentials,
          email: { send: 'ses' },
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  await messaging.email.send(message)
  expect(new URL(urls[0]!).host).toBe('api.resend.com')
})

test('the host can set a managed channel sender; one declared in code wins', async () => {
  const { fetchFn } = fetchSpy()
  const messaging = createMessaging(
    {
      marketing: email(),
      email: email({ from: 'Shop <orders@shop.example>' }),
    },
    {
      db: db as never,
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          resend: { ...credentials.resend, from: 'Shop <hello@shop.example>' },
          email: {
            send: 'resend',
            channels: {
              marketing: { from: 'Shop <news@news.shop.example>' },
              email: { from: 'ignored@news.shop.example' },
            },
          },
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  await messaging.marketing.send(message)
  await messaging.email.send(message)
  const senders = fetchFn.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).from,
  )
  expect(senders).toEqual([
    'Shop <news@news.shop.example>',
    'Shop <orders@shop.example>',
  ])
})
