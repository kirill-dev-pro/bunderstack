import { expect, test } from 'bun:test'

import { validateEnv } from '../env'
import { resend } from './email'
import { createMessaging } from './standalone'
import { telegram } from './telegram'

const env = validateEnv(undefined, { source: { DATABASE_URL: ':memory:' } })

test('a standalone channel without credentials captures instead of sending', async () => {
  const messaging = createMessaging(
    { email: resend({ from: 'App <hello@example.com>' }) },
    { env },
  )

  const sent = await messaging.email.send({
    to: 'user@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })

  expect(sent.id).toStartWith('message_')
  expect(sent.providerId).toBeUndefined()
})

test('a standalone channel sends through its configured provider', async () => {
  const calls: { url: string; body: unknown }[] = []
  // The adapter binds fetch when the facade is built, so replace it first.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ result: { message_id: 42 } }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const messaging = createMessaging(
      { ops: telegram({ botToken: 'bot-token' }) },
      { env },
    )
    const sent = await messaging.ops.send({ to: '@release', text: 'shipped' })
    expect(sent.providerId).toBe('42')
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(calls).toEqual([
    {
      url: 'https://api.telegram.org/botbot-token/sendMessage',
      body: { chat_id: '@release', text: 'shipped' },
    },
  ])
})
