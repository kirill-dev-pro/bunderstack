import { hashPassword as betterAuthHash } from 'better-auth/crypto'
import { expect, test } from 'bun:test'

import type { BetterAuthConfig } from './config'

import {
  createPasswordHasher,
  passwordHasher,
  withPasswordDefaults,
} from './auth-password'

const pureJs = createPasswordHasher({ nativeScrypt: null })

test('a hash made by BetterAuth verifies with both implementations', async () => {
  const hash = await betterAuthHash('correct horse')
  expect(await passwordHasher.verify({ hash, password: 'correct horse' })).toBe(
    true,
  )
  expect(await pureJs.verify({ hash, password: 'correct horse' })).toBe(true)
  expect(await pureJs.verify({ hash, password: 'wrong' })).toBe(false)
})

test('a hash made by the pure-JS path verifies with the native path', async () => {
  const hash = await pureJs.hash('pässwörd')
  expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
  expect(await passwordHasher.verify({ hash, password: 'pässwörd' })).toBe(true)
})

test('a native scrypt that throws falls back to pure JS', async () => {
  const hasher = createPasswordHasher({
    nativeScrypt: async () => {
      throw Object.assign(new Error('The scrypt method is not implemented'), {
        code: 'ERR_METHOD_NOT_IMPLEMENTED',
      })
    },
  })
  const hash = await hasher.hash('x')
  expect(await pureJs.verify({ hash, password: 'x' })).toBe(true)
})

test('withPasswordDefaults fills the hasher only when email auth is on', () => {
  expect(
    withPasswordDefaults<BetterAuthConfig>({}).emailAndPassword,
  ).toBeUndefined()
  const on = withPasswordDefaults<BetterAuthConfig>({
    emailAndPassword: { enabled: true },
  })
  expect(typeof on.emailAndPassword?.password?.hash).toBe('function')
  const own = { hash: async () => 'h', verify: async () => true }
  const kept = withPasswordDefaults<BetterAuthConfig>({
    emailAndPassword: { enabled: true, password: own },
  })
  expect(kept.emailAndPassword?.password).toBe(own)
})
