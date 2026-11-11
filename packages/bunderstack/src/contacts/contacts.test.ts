import { beforeEach, expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { INTERNAL_TABLES } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { createContactsHandler } from './http'
import {
  CONTACTS_CAPTURE_PATH,
  createContacts,
  normalizeEmail,
  UNSUBSCRIBE_PATH,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from './index'

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']
let clock = 1_000

beforeEach(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
  clock = 1_000
})

function contacts(config?: Parameters<typeof createContacts>[0]['config']) {
  return createContacts({
    db: db as never,
    secret: 'test-secret',
    appUrl: 'https://shop.example',
    config,
    now: () => ++clock,
  })
}

test('emails are normalised and malformed ones refused', () => {
  expect(normalizeEmail('  Ana@Customer.Example ')).toBe('ana@customer.example')
  expect(normalizeEmail('not an address')).toBeNull()
  expect(normalizeEmail('a@b')).toBeNull()
})

test('upsert merges by address: tags add up, attributes merge, consent is kept', async () => {
  const c = contacts()
  const first = await c.upsert({
    email: 'Ana@Customer.Example',
    name: 'Ana',
    source: 'waitlist',
    tags: ['beta'],
    attributes: { plan: 'free' },
    consent: { source: 'waitlist form', at: 10 },
  })
  expect(first).toMatchObject({
    name: 'Ana',
    source: 'waitlist',
    tags: ['beta'],
    attributes: { plan: 'free' },
  })
  expect(first.addresses).toMatchObject([
    {
      kind: 'email',
      address: 'ana@customer.example',
      consentedAt: 10,
      consentSource: 'waitlist form',
      unsubscribedAt: null,
    },
  ])

  const second = await c.upsert({
    email: 'ana@customer.example',
    source: 'landing',
    tags: ['newsletter', 'beta'],
    attributes: { city: 'Lisbon' },
    consent: { source: 'other', at: 99 },
  })
  expect(second.id).toBe(first.id)
  expect(second.source).toBe('waitlist')
  expect(second.tags).toEqual(['beta', 'newsletter'])
  expect(second.attributes).toEqual({ plan: 'free', city: 'Lisbon' })
  expect(second.addresses[0]?.consentedAt).toBe(10)
  expect(
    await c.upsert({ email: 'bad' }).catch((e: Error) => e.message),
  ).toContain('is not an email address')
})

test('list filters by tag, source, search and status, newest first', async () => {
  const c = contacts()
  await c.upsert({
    email: 'a@shop.example',
    name: 'Ana',
    tags: ['beta'],
    source: 'waitlist',
  })
  await c.upsert({ email: 'b@shop.example', name: 'Boris', source: 'landing' })
  await c.upsert({
    email: 'c@shop.example',
    name: 'Chen',
    tags: ['beta'],
    consent: {},
  })
  await c.unsubscribe({ email: 'a@shop.example' })

  const all = await c.list()
  expect(all.total).toBe(3)
  expect(all.contacts.map((x) => x.name)).toEqual(['Chen', 'Boris', 'Ana'])
  expect((await c.list({ tag: 'beta' })).contacts.map((x) => x.name)).toEqual([
    'Chen',
    'Ana',
  ])
  expect((await c.list({ source: 'landing' })).total).toBe(1)
  expect((await c.list({ search: 'bor' })).contacts[0]?.name).toBe('Boris')
  expect((await c.list({ search: 'c@shop' })).contacts[0]?.name).toBe('Chen')
  expect(
    (await c.list({ status: 'unsubscribed' })).contacts.map((x) => x.name),
  ).toEqual(['Ana'])
  expect((await c.list({ status: 'subscribed' })).total).toBe(2)
  expect(
    (await c.list({ status: 'consented' })).contacts.map((x) => x.name),
  ).toEqual(['Chen'])
  expect(
    (await c.list({ limit: 1, offset: 1 })).contacts.map((x) => x.name),
  ).toEqual(['Boris'])
})

test('tag, untag, resubscribe and remove', async () => {
  const c = contacts()
  const ana = await c.upsert({ email: 'a@shop.example', tags: ['beta'] })
  expect((await c.tag({ email: 'a@shop.example' }, ['vip']))?.tags).toEqual([
    'beta',
    'vip',
  ])
  expect((await c.untag({ id: ana.id }, ['beta']))?.tags).toEqual(['vip'])
  await c.unsubscribe({ email: 'a@shop.example' })
  expect(
    (await c.get({ id: ana.id }))?.addresses[0]?.unsubscribedAt,
  ).not.toBeNull()
  await c.resubscribe({ email: 'a@shop.example' })
  expect((await c.get({ id: ana.id }))?.addresses[0]?.unsubscribedAt).toBeNull()
  expect(await c.remove({ email: 'a@shop.example' })).toBe(true)
  expect(await c.get({ id: ana.id })).toBeNull()
  expect(await c.remove({ id: ana.id })).toBe(false)
  expect(await c.tag({ id: 'contact_missing' }, ['x'])).toBeNull()
})

test('unsubscribe tokens name one address and cannot be forged', async () => {
  const token = await unsubscribeToken('secret', 'caddr_1')
  expect(await verifyUnsubscribeToken('secret', token)).toBe('caddr_1')
  expect(await verifyUnsubscribeToken('other', token)).toBeNull()
  expect(
    await verifyUnsubscribeToken('secret', token.replace('caddr_1', 'caddr_2')),
  ).toBeNull()
  expect(await verifyUnsubscribeToken('secret', 'garbage')).toBeNull()
})

test('the unsubscribe link shows a page on GET and unsubscribes on a one-click POST', async () => {
  const c = contacts()
  await c.upsert({ email: 'ana@customer.example' })
  const handler = createContactsHandler(c, undefined)
  const url = (await c.unsubscribeUrl({ email: 'ana@customer.example' }))!
  expect(url.startsWith(`https://shop.example${UNSUBSCRIBE_PATH}?t=`)).toBe(
    true,
  )

  const shown = (await handler(new Request(url)))!
  expect(shown.status).toBe(200)
  expect(await shown.text()).toContain('<form method="post"')
  expect(
    (await c.get({ email: 'ana@customer.example' }))?.addresses[0]
      ?.unsubscribedAt,
  ).toBeNull()

  // RFC 8058: the mail client posts `List-Unsubscribe=One-Click`.
  const done = (await handler(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }),
  ))!
  expect(done.status).toBe(200)
  expect(await done.text()).toContain('a••@customer.example')
  expect(
    (await c.get({ email: 'ana@customer.example' }))?.addresses[0]
      ?.unsubscribedAt,
  ).not.toBeNull()

  const forged = (await handler(
    new Request(`https://shop.example${UNSUBSCRIBE_PATH}?t=caddr_x.nope`, {
      method: 'POST',
    }),
  ))!
  expect(forged.status).toBe(400)
})

test('an own unsubscribe page gets the token', async () => {
  const c = contacts({
    unsubscribeUrl: 'https://shop.example/account/unsubscribe',
  })
  await c.upsert({ email: 'ana@customer.example' })
  const url = new URL(
    (await c.unsubscribeUrl({ email: 'ana@customer.example' }))!,
  )
  expect(url.pathname).toBe('/account/unsubscribe')
  expect(await c.unsubscribeByToken(url.searchParams.get('t')!)).toEqual({
    address: 'ana@customer.example',
  })
})

test('capture is mounted only when configured and never reveals what is known', async () => {
  const off = createContactsHandler(contacts(), undefined)
  expect(
    await off(
      new Request(`https://shop.example${CONTACTS_CAPTURE_PATH}`, {
        method: 'POST',
      }),
    ),
  ).toBeNull()

  const c = contacts({
    capture: { source: 'landing', tags: ['newsletter'], consent: true },
  })
  const handler = createContactsHandler(c, {
    capture: { source: 'landing', tags: ['newsletter'], consent: true },
  })
  const post = (body: BodyInit, type: string, ip = '1.1.1.1') =>
    handler(
      new Request(`https://shop.example${CONTACTS_CAPTURE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': type, 'x-forwarded-for': ip },
        body,
      }),
    )

  const json = (await post(
    JSON.stringify({ email: 'Ana@Customer.example', name: 'Ana' }),
    'application/json',
  ))!
  expect(json.status).toBe(204)
  const again = (await post(
    JSON.stringify({ email: 'ana@customer.example' }),
    'application/json',
  ))!
  expect(again.status).toBe(204)
  const saved = await c.get({ email: 'ana@customer.example' })
  expect(saved).toMatchObject({
    name: 'Ana',
    source: 'landing',
    tags: ['newsletter'],
  })
  expect(saved?.addresses[0]?.consentSource).toBe('landing')

  const form = (await post(
    'email=boris%40shop.example&redirect=%2Fthanks',
    'application/x-www-form-urlencoded',
  ))!
  expect(form.status).toBe(303)
  expect(form.headers.get('location')).toBe('/thanks')

  const offsite = (await post(
    'email=c%40shop.example&redirect=%2F%2Fevil.example',
    'application/x-www-form-urlencoded',
  ))!
  expect(offsite.status).toBe(204)

  const bot = (await post(
    JSON.stringify({ email: 'bot@spam.example', website: 'x' }),
    'application/json',
  ))!
  expect(bot.status).toBe(204)
  expect(await c.get({ email: 'bot@spam.example' })).toBeNull()

  expect(
    (await post(JSON.stringify({ email: 'nope' }), 'application/json'))!.status,
  ).toBe(400)

  let last: Response | null = null
  for (let i = 0; i < 12; i += 1) {
    last = await post(
      JSON.stringify({ email: `x${i}@shop.example` }),
      'application/json',
      '9.9.9.9',
    )
  }
  expect(last!.status).toBe(429)
})
