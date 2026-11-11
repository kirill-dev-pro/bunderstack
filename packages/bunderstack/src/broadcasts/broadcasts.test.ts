import { beforeEach, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createContactsHandler } from '../contacts/http'
import { createContacts } from '../contacts/index'
import { libsql } from '../database/libsql'
import { createDb } from '../db'
import {
  bunderstackBroadcastRecipients,
  bunderstackBroadcasts,
  INTERNAL_TABLES,
} from '../internal-tables'
import { email } from '../messaging/email'
import { createMessaging } from '../messaging/runtime'
import { provisionSchema } from '../provision-schema'
import { renderBroadcast, renderTemplate, runBroadcast } from './index'

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']
let sent: {
  to: string
  subject: string
  html: string
  text?: string
  headers: Record<string, string>
  from: string
  tags: unknown
}[]
let failFor: Set<string>

beforeEach(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
  sent = []
  failFor = new Set()
})

const appUrl = 'https://shop.example'
const secret = 'test-secret'

function messaging() {
  const fetchFn = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (failFor.has(body.to[0])) {
      return new Response('rejected', { status: 422 })
    }
    sent.push({ ...body, to: body.to[0] })
    return Response.json({ id: `re_${sent.length}` })
  })
  return createMessaging(
    { news: email({ from: 'Shop <news@news.shop.example>' }) },
    {
      env: {
        DATABASE_URL: ':memory:',
        AUTH_SECRET: secret,
        BUNDERSTACK_ROLE: 'worker',
        BUNDERHOST_ENVIRONMENT_ID: 'env_1',
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify({
          resend: { apiKey: 're_key' },
          email: { send: 'resend' },
        }),
      },
      fetchFn: fetchFn as never,
    },
  ) as Record<string, unknown>
}

const contacts = () =>
  createContacts({ db: db as never, secret, appUrl, now: () => Date.now() })

async function broadcast(
  values: Partial<typeof bunderstackBroadcasts.$inferInsert> = {},
) {
  const id = `bc_${crypto.randomUUID()}`
  await db.insert(bunderstackBroadcasts).values({
    id,
    name: 'November news',
    channel: 'news',
    subject: 'Hello {{name | there}}',
    html: '<p>Hi {{name | there}}, your plan is {{attributes.plan}}.</p>',
    text: 'Hi {{name | there}}',
    audienceJson: JSON.stringify({}),
    status: 'approved',
    createdAt: 1,
    updatedAt: 1,
    ...values,
  })
  return id
}

const row = async (id: string) =>
  (
    await db
      .select()
      .from(bunderstackBroadcasts)
      .where(eq(bunderstackBroadcasts.id, id))
  )[0]!

const run = (
  id: string,
  extra: Partial<Parameters<typeof runBroadcast>[0]> = {},
  input: { testTo?: string[] } = {},
) =>
  runBroadcast(
    {
      db: db as never,
      messaging: messaging(),
      secret,
      appUrl,
      environmentId: 'env_1',
      sleep: async () => {},
      ...extra,
    },
    { broadcastId: id, ...input },
    new AbortController().signal,
  )

test('templates personalise, fall back and escape', () => {
  const values = {
    name: '<Ana>',
    email: 'ana@customer.example',
    attributes: { plan: 'pro' },
    unsubscribeUrl: 'https://shop.example/u?t=1',
  }
  expect(
    renderTemplate(
      'Hi {{ name }} on {{attributes.plan}}{{missing}}',
      values,
      'html',
    ),
  ).toBe('Hi &#60;Ana&#62; on pro')
  expect(
    renderTemplate('Hi {{name | there}}', { ...values, name: null }, 'text'),
  ).toBe('Hi there')
  const message = renderBroadcast(
    { subject: 'S', html: '<body><p>x</p></body>', text: 'x' },
    values,
  )
  expect(message.html).toContain('href="https://shop.example/u?t=1"')
  expect(message.html.indexOf('Unsubscribe')).toBeLessThan(
    message.html.indexOf('</body>'),
  )
  expect(message.text).toContain('Unsubscribe: https://shop.example/u?t=1')
  expect(message.headers).toEqual({
    'List-Unsubscribe': '<https://shop.example/u?t=1>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  })
  // A template that places the link itself gets no second footer.
  expect(
    renderBroadcast(
      {
        subject: 'S',
        html: '<a href="{{unsubscribe_url}}">out</a>',
        text: null,
      },
      values,
    ).html,
  ).toBe('<a href="https://shop.example/u?t=1">out</a>')
})

test('an approved broadcast goes to its audience once, never to who opted out', async () => {
  const c = contacts()
  await c.upsert({
    email: 'ana@customer.example',
    name: 'Ana',
    tags: ['beta'],
    attributes: { plan: 'pro' },
    consent: {},
  })
  await c.upsert({
    email: 'boris@customer.example',
    tags: ['beta', 'staff'],
    consent: {},
  })
  await c.upsert({ email: 'chen@customer.example', tags: ['beta'] })
  await c.upsert({
    email: 'dana@customer.example',
    tags: ['beta'],
    consent: {},
  })
  await c.upsert({
    email: 'eve@customer.example',
    tags: ['other'],
    consent: {},
  })
  await c.unsubscribe({ email: 'dana@customer.example' })

  const id = await broadcast({
    audienceJson: JSON.stringify({
      tags: { any: ['beta'], none: ['staff'] },
      consent: 'required',
    }),
  })
  expect(await run(id)).toEqual({ done: true })
  expect(sent.map((m) => m.to)).toEqual(['ana@customer.example'])
  const [message] = sent
  expect(message!.subject).toBe('Hello Ana')
  expect(message!.html).toContain('your plan is pro')
  expect(message!.from).toBe('Shop <news@news.shop.example>')
  expect(message!.headers['List-Unsubscribe-Post']).toBe(
    'List-Unsubscribe=One-Click',
  )
  expect(message!.headers['List-Unsubscribe']).toContain('&b=' + id)
  expect(message!.tags).toEqual([
    {
      name: 'bunderstack_broadcast_recipient_id',
      value: expect.stringMatching(/^brr_/),
    },
    { name: 'bunderhost_environment_id', value: 'env_1' },
  ])
  expect(await row(id)).toMatchObject({
    status: 'sent',
    recipients: 1,
    sent: 1,
    failed: 0,
  })

  // Running again sends nothing more.
  await run(id)
  expect(sent).toHaveLength(1)
})

test('drafts and cancelled broadcasts are not sent; a cancel stops a send', async () => {
  const c = contacts()
  for (const name of ['a', 'b', 'c'])
    await c.upsert({ email: `${name}@customer.example` })
  const draft = await broadcast({ status: 'draft' })
  await run(draft)
  expect(sent).toHaveLength(0)

  const id = await broadcast()
  let calls = 0
  await run(id, {
    sleep: async () => {
      calls += 1
      if (calls === 1) {
        await db
          .update(bunderstackBroadcasts)
          .set({ status: 'cancelled' })
          .where(eq(bunderstackBroadcasts.id, id))
      }
    },
  })
  // The batch in hand finishes; the next check sees the cancel.
  expect((await row(id)).status).toBe('cancelled')
  const queued = await db
    .select()
    .from(bunderstackBroadcastRecipients)
    .where(eq(bunderstackBroadcastRecipients.status, 'queued'))
  expect(sent.length + queued.length).toBe(3)
})

test('a run out of time hands over; an interrupted row is reported, not resent', async () => {
  const c = contacts()
  for (const name of ['a', 'b', 'c'])
    await c.upsert({ email: `${name}@customer.example` })
  const id = await broadcast()
  let clock = 0
  const first = await run(id, { now: () => (clock += 1000), runBudgetMs: 2500 })
  expect(first.done).toBe(false)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.length).toBeLessThan(3)

  // Simulate a run that died after claiming a row.
  const [queued] = await db
    .select()
    .from(bunderstackBroadcastRecipients)
    .where(eq(bunderstackBroadcastRecipients.status, 'queued'))
  await db
    .update(bunderstackBroadcastRecipients)
    .set({ status: 'sending' })
    .where(eq(bunderstackBroadcastRecipients.id, queued!.id))

  expect((await run(id)).done).toBe(true)
  const done = await row(id)
  expect(done.status).toBe('sent')
  expect(done.sent + done.failed).toBe(3)
  expect(done.failed).toBe(1)
  expect(sent.map((m) => m.to)).not.toContain(queued!.address)
})

test('a provider refusal fails that recipient and the rest still go', async () => {
  const c = contacts()
  await c.upsert({ email: 'a@customer.example' })
  await c.upsert({ email: 'b@customer.example' })
  failFor.add('a@customer.example')
  const id = await broadcast()
  await run(id)
  expect(await row(id)).toMatchObject({ status: 'sent', sent: 1, failed: 1 })
  const [failed] = await db
    .select()
    .from(bunderstackBroadcastRecipients)
    .where(eq(bunderstackBroadcastRecipients.status, 'failed'))
  expect(failed!.error).toContain('422')
})

test('a test send goes only to the testers and leaves the broadcast alone', async () => {
  await contacts().upsert({ email: 'a@customer.example' })
  const id = await broadcast({ status: 'draft' })
  await run(id, {}, { testTo: ['me@shop.example'] })
  expect(sent.map((m) => [m.to, m.subject])).toEqual([
    ['me@shop.example', '[Test] Hello there'],
  ])
  expect(await row(id)).toMatchObject({
    status: 'draft',
    sent: 0,
    recipients: 0,
  })
})

test('without APP_URL a broadcast fails instead of sending mail nobody can leave', async () => {
  await contacts().upsert({ email: 'a@customer.example' })
  const id = await broadcast()
  await run(id, { appUrl: undefined })
  expect(sent).toHaveLength(0)
  expect(await row(id)).toMatchObject({ status: 'failed' })
})

test('unsubscribing from a broadcast link counts on that broadcast', async () => {
  const c = contacts()
  await c.upsert({ email: 'a@customer.example' })
  const id = await broadcast()
  await run(id)
  const link = sent[0]!.headers['List-Unsubscribe']!.slice(1, -1)
  const response = (await createContactsHandler(
    c,
    undefined,
  )(
    new Request(link, {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }),
  ))!
  expect(response.status).toBe(200)
  expect((await row(id)).unsubscribed).toBe(1)
  expect(
    (await c.get({ email: 'a@customer.example' }))?.addresses[0]
      ?.unsubscribedAt,
  ).not.toBeNull()
})

test('the broadcast job exists only where a worker already runs and email is declared', async () => {
  const { bunderstack } = await import('../index')
  const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
  const { BROADCAST_JOB_NAME } = await import('./index')
  const notes = sqliteTable('broadcast_notes', { id: text('id').primaryKey() })
  const withWorker = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    background: { autoStart: false },
    messaging: { news: email() },
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
  }).start()
  const { provision } = await import('../provision-schema')
  await provision(withWorker, { force: true })
  try {
    await expect(
      withWorker.jobs.enqueue(
        BROADCAST_JOB_NAME as never,
        { broadcastId: 'bc_1' } as never,
      ),
    ).resolves.toMatchObject({ id: expect.any(String) })
  } finally {
    await withWorker.close()
  }

  const withoutWorker = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    messaging: { news: email() },
  }).start()
  try {
    await expect(
      withoutWorker.jobs.enqueue(
        BROADCAST_JOB_NAME as never,
        { broadcastId: 'bc_1' } as never,
      ),
    ).rejects.toThrow('no jobs configured')
  } finally {
    await withoutWorker.close()
  }
})
