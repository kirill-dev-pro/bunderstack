import { expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})
const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull(),
})
const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull(),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})
const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }),
})

const schema = { user, session, account, verification }

test('real sign-up returns an identity accepted by the typed client', async () => {
  const backend = bunderstack({
    schema,
    database: { adapter: libsql() },
    email: { from: 'Test <test@example.com>', provider: 'resend' },
    auth: {
      emailAndPassword: { enabled: true },
      emailVerification: { sendOnSignUp: true },
    },
    api: (o) => ({
      account: {
        me: o.protected.handler(({ context }) => ({ id: context.user.id })),
      },
    }),
  })

  await using t = await backend.test({ database: { schema: 'push' } })
  const alice = await t.auth.signUpEmail({
    email: 'alice@test.local',
    name: 'Alice',
  })

  expect(alice.user.email).toBe('alice@test.local')
  expect(alice.headers.get('cookie')).toContain('better-auth.session_token=')
  expect(await t.client(alice).account.me()).toEqual({ id: alice.user.id })

  // @ts-expect-error unknown procedures must stay rejected by app inference
  void t.client(alice).account.unknown

  await expect(
    t.auth.signUpEmail({ email: 'alice@test.local', name: 'Duplicate' }),
  ).rejects.toMatchObject({ name: 'TestAuthError', status: 422 })

  const mocked = t.auth.mockSession({
    id: 'mock-user',
    email: 'mock@test.local',
    name: 'Mock',
  })
  expect(await t.client(mocked).account.me()).toEqual({ id: 'mock-user' })

  const other = t.auth.mockSession({
    id: 'other-user',
    email: 'other@test.local',
    name: 'Other',
  })
  expect(await t.client(mocked).account.me()).toEqual({ id: 'mock-user' })
  expect(await t.client(other).account.me()).toEqual({ id: 'other-user' })
})

test('email auth helpers verify, sign out, and sign in through the real handler', async () => {
  const backend = bunderstack({
    schema,
    database: { adapter: libsql() },
    email: { from: 'Test <test@example.com>', provider: 'resend' },
    auth: {
      emailAndPassword: { enabled: true },
      emailVerification: { sendOnSignUp: true },
    },
  })

  await using fixture = await backend.test({ database: { schema: 'push' } })
  const signedUp = await fixture.auth.signUpEmail({
    email: 'verify@test.local',
    name: 'Verify Me',
  })

  const verified = await fixture.auth.verifyEmail(signedUp)
  expect(verified.user.emailVerified).toBe(true)
  expect((await fixture.auth.getSession(verified))?.user.id).toBe(
    signedUp.user.id,
  )

  await fixture.auth.signOut(verified)
  expect(await fixture.auth.getSession(verified)).toBeNull()

  const signedIn = await fixture.auth.signInEmail({
    email: 'verify@test.local',
  })
  expect(signedIn.user.id).toBe(signedUp.user.id)
})
