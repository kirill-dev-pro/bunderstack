import { beforeAll, expect, test } from 'bun:test'
// A pg-dialect user table so withInternalTables picks the pg twins.
import { pgTable, text } from 'drizzle-orm/pg-core'

import { pglite } from '../database/pglite'
import { createDb } from '../db'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { createContacts } from './index'

const marker = pgTable('contacts_pg_marker', { id: text('id').primaryKey() })

let db: Awaited<ReturnType<typeof createDb>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(
    { marker },
    { url: 'memory://', dialect: 'pg', adapter: pglite() },
  ))
  await provisionSchema(db as never, withInternalTables({ marker }), {
    force: true,
  })
})

test('contacts work the same on Postgres', async () => {
  const c = createContacts({
    db: db as never,
    secret: 's',
    appUrl: 'https://shop.example',
  })
  const ana = await c.upsert({
    email: 'ana@shop.example',
    name: 'Ana',
    tags: ['beta'],
    consent: {},
  })
  await c.upsert({
    email: 'ana@shop.example',
    tags: ['vip'],
    attributes: { plan: 'pro' },
  })
  await c.upsert({ email: 'boris@shop.example', name: 'Boris' })
  await c.unsubscribe({ email: 'boris@shop.example' })

  expect((await c.get({ id: ana.id }))?.tags).toEqual(['beta', 'vip'])
  expect((await c.list({ tag: 'vip' })).contacts.map((x) => x.name)).toEqual([
    'Ana',
  ])
  expect((await c.list({ search: 'BOR' })).total).toBe(1)
  expect(
    (await c.list({ status: 'subscribed' })).contacts.map((x) => x.name),
  ).toEqual(['Ana'])
  const url = new URL((await c.unsubscribeUrl({ email: 'ana@shop.example' }))!)
  expect(await c.unsubscribeByToken(url.searchParams.get('t')!)).toEqual({
    address: 'ana@shop.example',
  })
  expect(await c.remove({ id: ana.id })).toBe(true)
  expect((await c.list()).total).toBe(1)
})
