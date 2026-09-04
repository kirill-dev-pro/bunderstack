import { expect, mock, spyOn, test } from 'bun:test'

import { resend } from './email'
import { createMessaging } from './runtime'
import { telegram } from './telegram'

const env = {
  DATABASE_URL: ':memory:',
  AUTH_SECRET: 'test',
  BUNDERSTACK_ROLE: 'web' as const,
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('explicit Resend credentials win over managed defaults', async () => {
  const fetchFn = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ok({ id: 'sent_1' }),
  )
  const messaging = createMessaging(
    { email: resend({ apiKey: 'explicit', from: 'explicit@example.com' }) },
    {
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          resend: { apiKey: 'managed', from: 'managed@example.com' },
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  await messaging.email.send({
    to: 'a@example.com',
    subject: 'Hi',
    text: 'Body',
  })
  const [, init] = fetchFn.mock.calls[0]!
  expect((init as RequestInit).headers).toMatchObject({
    Authorization: 'Bearer explicit',
  })
  expect(JSON.parse((init as RequestInit).body as string).from).toBe(
    'explicit@example.com',
  )
})

test('empty descriptor fields are filled by managed defaults', async () => {
  const fetchFn = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ok({ id: 'sent_2' }),
  )
  const messaging = createMessaging(
    { email: resend({ apiKey: '', from: '' }) },
    {
      env: {
        ...env,
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          resend: { apiKey: 'managed', from: 'managed@example.com' },
        }),
      },
      fetchFn: fetchFn as never,
    },
  )
  await messaging.email.send({
    to: 'a@example.com',
    subject: 'Hi',
    text: 'Body',
  })
  expect(fetchFn).toHaveBeenCalledTimes(1)
})

test('missing credentials capture locally instead of making a request', async () => {
  const fetchFn = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ok({ id: 'unexpected' }),
  )
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const messaging = createMessaging(
      { email: resend({ from: 'app@example.com' }) },
      { env, fetchFn: fetchFn as never },
    )
    await expect(
      messaging.email.send({
        to: 'a@example.com',
        subject: 'Hi',
        text: 'Body',
      }),
    ).resolves.toHaveProperty('id')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  } finally {
    log.mockRestore()
  }
})

test('a configured provider failure is surfaced and never captured', async () => {
  const fetchFn = mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('down', { status: 503 }),
  )
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const messaging = createMessaging(
      { email: resend({ apiKey: 'key', from: 'app@example.com' }) },
      { env, fetchFn: fetchFn as never },
    )
    await expect(
      messaging.email.send({
        to: 'a@example.com',
        subject: 'Hi',
        text: 'Body',
      }),
    ).rejects.toThrow(/503/)
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

test('Telegram uses its Bot API endpoint and provider-specific payload', async () => {
  const fetchFn = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ok({ result: { message_id: 42 } }),
  )
  const messaging = createMessaging(
    { telegram: telegram({ botToken: 'token' }) },
    { env, fetchFn: fetchFn as never },
  )
  await expect(
    messaging.telegram.send({ to: 123, text: 'Hello', parseMode: 'HTML' }),
  ).resolves.toMatchObject({ providerId: '42' })
  const [url, init] = fetchFn.mock.calls[0]!
  expect(url).toBe('https://api.telegram.org/bottoken/sendMessage')
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
    chat_id: 123,
    text: 'Hello',
    parse_mode: 'HTML',
  })
})

test('hosted capture does not print message bodies', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const messaging = createMessaging(
      { telegram: telegram() },
      { env: { ...env, BUNDERHOST_ENVIRONMENT_ID: 'env_1' } },
    )
    await messaging.telegram.send({ to: 123, text: 'secret body' })
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})
