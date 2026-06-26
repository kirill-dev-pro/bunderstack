import { test, expect } from 'bun:test'

import {
  encode,
  decode,
  isValidPrefix,
  generate,
  parse,
  asTypeId,
  typeid,
} from '../src/typeid'
import { createDb } from '../src/db'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Official TypeID spec test vector (encode/decode the raw 16-byte UUID).
const VECTOR_UUID = '01890a5d-ac96-774b-bcce-b302099a8057'
const VECTOR_SUFFIX = '01h455vb4pex5vsknk084sn02q'

function uuidToBytes(uuid: string): Uint8Array {
  return Uint8Array.from(uuid.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)))
}

test('encode produces the spec suffix for a known UUID', () => {
  expect(encode(uuidToBytes(VECTOR_UUID))).toBe(VECTOR_SUFFIX)
})

test('encode always yields 26 characters', () => {
  expect(encode(new Uint8Array(16)).length).toBe(26)
})

test('decode is the inverse of encode', () => {
  const bytes = uuidToBytes(VECTOR_UUID)
  expect(Buffer.from(decode(encode(bytes))).toString('hex')).toBe(
    Buffer.from(bytes).toString('hex'),
  )
})

test('isValidPrefix accepts spec-valid prefixes', () => {
  expect(isValidPrefix('post')).toBe(true)
  expect(isValidPrefix('user_account')).toBe(true)
  expect(isValidPrefix('a')).toBe(true)
})

test('isValidPrefix rejects invalid prefixes', () => {
  expect(isValidPrefix('')).toBe(false) // we require a non-empty prefix
  expect(isValidPrefix('Post')).toBe(false) // uppercase
  expect(isValidPrefix('_post')).toBe(false) // leading underscore
  expect(isValidPrefix('post_')).toBe(false) // trailing underscore
  expect(isValidPrefix('po5t')).toBe(false) // digit
  expect(isValidPrefix('a'.repeat(64))).toBe(false) // too long
})

test('generate yields prefix_suffix with a 26-char base32 suffix', () => {
  const id = generate('post')
  expect(id.startsWith('post_')).toBe(true)
  expect(id.slice('post_'.length).length).toBe(26)
})

test('generate embeds a UUIDv7 (version nibble is 7)', () => {
  const id = generate('post')
  const { uuid } = parse(id)
  expect(uuid[14]).toBe('7') // version nibble position in 8-4-4-4-12 layout
})

test('generate produces unique ids', () => {
  expect(generate('post')).not.toBe(generate('post'))
})

test('parse splits prefix, suffix and decodes the uuid', () => {
  const id = `prefix_${VECTOR_SUFFIX}`
  const result = parse(id)
  expect(result.prefix).toBe('prefix')
  expect(result.suffix).toBe(VECTOR_SUFFIX)
  expect(result.uuid).toBe(VECTOR_UUID)
})

test('parse throws on a malformed id', () => {
  expect(() => parse('not-a-typeid')).toThrow()
})

test('parse throws when the prefix does not match the expected prefix', () => {
  expect(() => parse(`user_${VECTOR_SUFFIX}`, 'post')).toThrow()
})

test('asTypeId validates and brands a raw string', () => {
  const raw = `post_${VECTOR_SUFFIX}`
  expect(asTypeId('post', raw) as string).toBe(raw)
})

test('asTypeId throws when the raw string has the wrong prefix', () => {
  expect(() => asTypeId('post', `user_${VECTOR_SUFFIX}`)).toThrow()
})

test('typeid() builds a text column that auto-generates a prefixed id on insert', async () => {
  const widgets = sqliteTable('widgets', {
    id: typeid('widget').primaryKey(),
    name: text('name').notNull(),
  })
  const db = createDb({ widgets }, { url: ':memory:' })
  await db.$client.execute(
    `CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  )

  const inserted = await db.insert(widgets).values({ name: 'gear' }).returning()
  const id = inserted[0]!.id
  expect(typeof id).toBe('string')
  expect(id.startsWith('widget_')).toBe(true)
  expect(parse(id).prefix).toBe('widget')
})

test('typeid() throws at definition time for an invalid prefix', () => {
  expect(() => typeid('Bad_')).toThrow()
})
