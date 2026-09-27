// src/typeid.ts
//
// Zero-dependency TypeID implementation (https://github.com/jetify-com/typeid).
// Stripe-style prefixed, k-sortable identifiers: `prefix_<26-char base32 UUIDv7>`.
// The only runtime primitive we need is UUIDv7 bytes. `uuidv7Bytes` builds them
// from WebCrypto, so the same code runs in Bun, workerd, and celld without the
// `uuid` dependency that the reference `typeid-js` package relies on.

import { customType } from 'drizzle-orm/sqlite-core'

// Crockford base32 alphabet (lowercase, excludes i/l/o/u), as used by the TypeID spec.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

// Spec prefix rules: lowercase ascii, underscores allowed only internally, 1–63 chars.
const PREFIX_RE = /^[a-z]([a-z_]{0,61}[a-z])?$/
// 26 base32 chars from the alphabet above.
const SUFFIX_RE = /^[0-9a-hjkmnp-tv-z]{26}$/

declare const typeIdBrand: unique symbol

/** A branded TypeID string. `TypeId<'post'>` is incompatible with `TypeId<'user'>`. */
export type TypeId<P extends string> = string & { readonly [typeIdBrand]?: P }

/** Encode a 16-byte UUID into the 26-character base32 suffix. */
export function encode(bytes: Uint8Array): string {
  // First two chars cover byte 0: top 3 bits, then low 5 bits.
  let out = ALPHABET[bytes[0]! >> 5]! + ALPHABET[bytes[0]! & 31]!
  // Remaining 15 bytes (120 bits) → 24 groups of 5 bits.
  let buf = 0n
  for (let i = 1; i < 16; i++) buf = (buf << 8n) | BigInt(bytes[i]!)
  const chars: string[] = []
  for (let i = 0; i < 24; i++) {
    chars.push(ALPHABET[Number((buf >> (BigInt(23 - i) * 5n)) & 31n)]!)
  }
  return out + chars.join('')
}

/** Decode a 26-character base32 suffix back into the original 16 UUID bytes. */
export function decode(suffix: string): Uint8Array {
  const map: Record<string, number> = {}
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]!] = i
  const bytes = new Uint8Array(16)
  bytes[0] = (map[suffix[0]!]! << 5) | map[suffix[1]!]!
  let buf = 0n
  for (let i = 2; i < 26; i++) buf = (buf << 5n) | BigInt(map[suffix[i]!]!)
  for (let i = 0; i < 15; i++)
    bytes[15 - i] = Number((buf >> BigInt(i * 8)) & 0xffn)
  return bytes
}

/** Whether a string is a valid, non-empty TypeID prefix. */
export function isValidPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix)
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Monotonic state: RFC 9562 method 1, a 12-bit counter in rand_a. Seeded with
// random bits below its top bit on each new millisecond, so it can grow.
let lastMs = -1
let counter = 0

export function uuidv7Bytes(now: number = Date.now()): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  if (now > lastMs) {
    lastMs = now
    counter = ((bytes[6]! & 0x07) << 8) | bytes[7]!
  } else {
    counter += 1
    if (counter > 0xfff) {
      // Counter overflow: borrow the next millisecond, keep the order.
      lastMs += 1
      counter = 0
    }
  }
  const ms = lastMs
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  return bytes
}

/** Generate a new, branded TypeID for the given prefix. */
export function generate<P extends string>(prefix: P): TypeId<P> {
  if (!isValidPrefix(prefix))
    throw new Error(`Invalid typeid prefix: "${prefix}"`)
  const bytes = uuidv7Bytes()
  return `${prefix}_${encode(bytes)}` as TypeId<P>
}

/**
 * Parse a TypeID into its parts and the decoded UUID. Throws if the id is
 * malformed or — when `expectedPrefix` is given — if the prefix does not match.
 */
export function parse<P extends string>(
  id: string,
  expectedPrefix?: P,
): { prefix: string; suffix: string; uuid: string } {
  const sep = id.lastIndexOf('_')
  if (sep <= 0) throw new Error(`Malformed typeid: "${id}"`)
  const prefix = id.slice(0, sep)
  const suffix = id.slice(sep + 1)
  if (!isValidPrefix(prefix))
    throw new Error(`Malformed typeid prefix: "${id}"`)
  if (!SUFFIX_RE.test(suffix))
    throw new Error(`Malformed typeid suffix: "${id}"`)
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) {
    throw new Error(
      `Expected typeid prefix "${expectedPrefix}" but got "${prefix}"`,
    )
  }
  return { prefix, suffix, uuid: bytesToUuid(decode(suffix)) }
}

/**
 * Escape hatch: validate a raw string against a prefix and brand it as a TypeID.
 * Use at trust boundaries (e.g. a raw URL param) where the string isn't yet typed.
 */
export function asTypeId<P extends string>(prefix: P, raw: string): TypeId<P> {
  parse(raw, prefix)
  return raw as TypeId<P>
}

/**
 * Drizzle column builder for a branded TypeID text value. Stores a plain `text`
 * column so drizzle-kit migrations and `$inferSelect` work unchanged.
 *
 * Use Drizzle's `$defaultFn` when a column should generate IDs on insert:
 *
 *   id: typeid('post').primaryKey().$defaultFn(() => generate('post'))
 */
export function typeid<P extends string>(prefix: P) {
  if (!isValidPrefix(prefix))
    throw new Error(`Invalid typeid prefix: "${prefix}"`)
  return customType<{ data: TypeId<P>; driverData: string }>({
    dataType: () => 'text',
  })()
}
