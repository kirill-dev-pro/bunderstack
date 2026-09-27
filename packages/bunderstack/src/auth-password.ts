// src/auth-password.ts — BetterAuth's scrypt password format, with a plain-JS
// fallback. BetterAuth picks node:crypto scrypt through its `workerd` and
// `node` export conditions; celld implements neither, so we choose at runtime.
import { scryptAsync } from '@noble/hashes/scrypt.js'
import * as nodeCrypto from 'node:crypto'

import type { BetterAuthConfig } from './config'

type ScryptFn = (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Uint8Array>

// Must match @better-auth/utils/password: existing hashes stay valid.
const PARAMS = { N: 16384, r: 16, p: 1 } as const
const KEY_LENGTH = 64
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const nodeScrypt: ScryptFn | null =
  typeof nodeCrypto.scrypt === 'function'
    ? (password, salt, keylen, options) =>
        new Promise((resolve, reject) =>
          nodeCrypto.scrypt(password, salt, keylen, options, (error, key) =>
            error ? reject(error) : resolve(new Uint8Array(key)),
          ),
        )
    : null

const pureScrypt: ScryptFn = (password, salt, keylen, options) =>
  scryptAsync(password, salt, { ...options, dkLen: keylen })

export function createPasswordHasher(
  options: { nativeScrypt?: ScryptFn | null } = {},
) {
  let native =
    options.nativeScrypt === undefined ? nodeScrypt : options.nativeScrypt

  async function derive(password: string, salt: string): Promise<Uint8Array> {
    const input = password.normalize('NFKC')
    const opts = { ...PARAMS, maxmem: MAXMEM }
    if (native) {
      try {
        return await native(input, salt, KEY_LENGTH, opts)
      } catch {
        // celld: "The scrypt method is not implemented". Stop trying.
        native = null
      }
    }
    return pureScrypt(input, salt, KEY_LENGTH, opts)
  }

  return {
    async hash(password: string): Promise<string> {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(16)))
      return `${salt}:${toHex(await derive(password, salt))}`
    },
    async verify({
      hash,
      password,
    }: {
      hash: string
      password: string
    }): Promise<boolean> {
      const [salt, key] = hash.split(':')
      if (!salt || !key) throw new Error('Invalid password hash')
      return toHex(await derive(password, salt)) === key
    },
  }
}

export const passwordHasher = createPasswordHasher()

/** Only fills a gap: a user-supplied password hasher always wins. */
export function withPasswordDefaults<
  T extends Pick<BetterAuthConfig, 'emailAndPassword'>,
>(cfg: T): T {
  if (!cfg.emailAndPassword?.enabled || cfg.emailAndPassword.password) {
    return cfg
  }
  return {
    ...cfg,
    emailAndPassword: {
      ...cfg.emailAndPassword,
      password: { hash: passwordHasher.hash, verify: passwordHasher.verify },
    },
  }
}
