// src/auth-email.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { EmailFacade } from './email'
import { withEmailAuthDefaults } from './auth'
import { createBunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

const fakeEmail: EmailFacade = { send: async () => ({}) }

test('injects sendResetPassword when emailAndPassword is enabled without one', () => {
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    fakeEmail,
    true,
  )
  expect(typeof cfg.emailAndPassword?.sendResetPassword).toBe('function')
})

test('never overrides a user-supplied sendResetPassword', () => {
  const mine = async () => {}
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true, sendResetPassword: mine } },
    fakeEmail,
    true,
  )
  expect(cfg.emailAndPassword?.sendResetPassword).toBe(mine)
})

test('injects emailVerification.sendVerificationEmail', () => {
  const cfg = withEmailAuthDefaults({}, fakeEmail, true)
  expect(typeof cfg.emailVerification?.sendVerificationEmail).toBe('function')
})

test('no injection when email is not configured', () => {
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    fakeEmail,
    false,
  )
  expect(cfg.emailAndPassword?.sendResetPassword).toBeUndefined()
  expect(cfg.emailVerification).toBeUndefined()
})

test('default reset template sends through the facade', async () => {
  const sent: unknown[] = []
  const email: EmailFacade = {
    send: async (msg) => {
      sent.push(msg)
      return {}
    },
  }
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    email,
    true,
  )
  await cfg.emailAndPassword!.sendResetPassword!(
    {
      user: { email: 'u@example.com', id: '1', name: 'U' },
      url: 'https://app/reset?token=t',
      token: 't',
    } as never,
    undefined as never,
  )
  expect(sent).toHaveLength(1)
  const msg = sent[0] as { to: string; text: string }
  expect(msg.to).toBe('u@example.com')
  expect(msg.text).toContain('https://app/reset?token=t')
})

test('app.email is exposed and unconfigured send throws', () => {
  const app = createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
  })
  expect(
    app.email.send({ to: 'a@b.c', subject: 's', text: 't' }),
  ).rejects.toThrow(/email is not configured/)
})

test('email provider resend requires RESEND_API_KEY at boot', () => {
  const hadKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  expect(() =>
    createBunderstack({
      schema: { notes },
      database: { url: ':memory:' },
      email: { from: 'app@example.com', provider: 'resend' },
    }),
  ).toThrow(/RESEND_API_KEY/)
  if (hadKey) process.env.RESEND_API_KEY = hadKey
})
