import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { InboundEmail } from './inbound'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { ses } from './email'
import {
  INBOUND_PATH,
  signInboundPayload,
  verifyInboundSignature,
} from './inbound'

const notes = sqliteTable('inbound_notes', { id: text('id').primaryKey() })
const SECRET = 'inbound-secret'
const managed = JSON.stringify({
  ses: {
    inbound: { secret: SECRET, channels: { inbox: ['mail.example.com'] } },
  },
})

function mailApp(received: InboundEmail[]) {
  return bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    messaging: {
      email: ses({ from: 'App <no-reply@example.com>' }),
      inbox: ses({ receive: true }),
    },
    jobs: (jobs) =>
      jobs.define({
        fileMail: jobs.inbound('inbox', {
          handler: async (message) => {
            received.push(message)
          },
        }),
      }),
  })
}

function delivery(id = 'ses-1') {
  return {
    id,
    channel: 'inbox',
    environmentId: 'env_1',
    receivedAt: '2026-11-02T10:00:00.000Z',
    envelope: {
      from: 'bounce@ats.example',
      to: ['anna.ivanova@mail.example.com'],
    },
    verdicts: {
      spf: 'PASS',
      dkim: 'PASS',
      dmarc: 'PASS',
      spam: 'PASS',
      virus: 'PASS',
    },
    message: {
      messageId: '<m1@ats.example>',
      inReplyTo: '<ours@eu-west-1.amazonses.com>',
      references: ['<ours@eu-west-1.amazonses.com>'],
      date: '2026-11-02T09:59:00.000Z',
      subject: 'Re: Your application',
      from: { address: 'recruiter@acme.example', name: 'Rita Recruiter' },
      to: [{ address: 'anna.ivanova@mail.example.com' }],
      text: 'Can we talk on Monday?',
      html: null,
      headers: [{ name: 'X-Mailer', value: 'ATS' }],
      attachments: [
        {
          filename: 'brief.pdf',
          contentType: 'application/pdf',
          size: 3,
          contentId: null,
        },
      ],
    },
    raw: { url: `data:message/rfc822;base64,${btoa('raw')}`, size: 3 },
  }
}

async function post(
  handler: (request: Request) => Promise<Response>,
  body: string,
  signature: string | null,
) {
  return handler(
    new Request(`http://app.local${INBOUND_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'bunderhost-signature': signature } : {}),
      },
      body,
    }),
  )
}

test('a signed delivery reaches the inbound handler once', async () => {
  const received: InboundEmail[] = []
  await using t = await mailApp(received).test({
    env: { BUNDERSTACK_MESSAGING_CONFIG: managed },
    database: { schema: 'push' },
  })
  expect(t.app.messaging.inbox.receiving).toBe(true)
  expect(t.app.messaging.inbox.domains).toEqual(['mail.example.com'])
  expect(t.app.messaging.email.receiving).toBe(false)

  const body = JSON.stringify(delivery())
  const response = await post(
    t.app.handler,
    body,
    await signInboundPayload(SECRET, body),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    accepted: true,
    duplicate: false,
  })
  await t.jobs.runUntilIdle()

  expect(received).toHaveLength(1)
  const [message] = received
  expect(message).toMatchObject({
    providerId: 'ses-1',
    channel: 'inbox',
    subject: 'Re: Your application',
    from: { address: 'recruiter@acme.example', name: 'Rita Recruiter' },
    inReplyTo: '<ours@eu-west-1.amazonses.com>',
    references: ['<ours@eu-west-1.amazonses.com>'],
    text: 'Can we talk on Monday?',
    html: null,
    envelope: { to: ['anna.ivanova@mail.example.com'] },
  })
  expect(message!.header('x-mailer')).toBe('ATS')
  expect(message!.attachments[0]).toMatchObject({ filename: 'brief.pdf' })
  expect(new TextDecoder().decode(await message!.raw())).toBe('raw')

  // The host retries when it misses the answer: nothing runs twice.
  const again = await post(
    t.app.handler,
    body,
    await signInboundPayload(SECRET, body),
  )
  expect(await again.json()).toMatchObject({ duplicate: true })
  await t.jobs.runUntilIdle()
  expect(received).toHaveLength(1)
})

test('deliveries without a valid signature or for a non-receiving channel are refused', async () => {
  const received: InboundEmail[] = []
  await using t = await mailApp(received).test({
    env: { BUNDERSTACK_MESSAGING_CONFIG: managed },
    database: { schema: 'push' },
  })
  const body = JSON.stringify(delivery())
  expect((await post(t.app.handler, body, null)).status).toBe(401)
  expect(
    (
      await post(
        t.app.handler,
        body,
        await signInboundPayload('someone-else', body),
      )
    ).status,
  ).toBe(401)
  const stale = await signInboundPayload(SECRET, body, Date.now() - 600_000)
  expect((await post(t.app.handler, body, stale)).status).toBe(401)

  const wrongChannel = JSON.stringify({ ...delivery(), channel: 'email' })
  const refused = await post(
    t.app.handler,
    wrongChannel,
    await signInboundPayload(SECRET, wrongChannel),
  )
  expect(refused.status).toBe(422)
  const broken = JSON.stringify({ ...delivery(), envelope: null })
  expect(
    (
      await post(
        t.app.handler,
        broken,
        await signInboundPayload(SECRET, broken),
      )
    ).status,
  ).toBe(422)
  await t.jobs.runUntilIdle()
  expect(received).toHaveLength(0)
})

test('without a host secret the endpoint accepts nothing and the channel is not receiving', async () => {
  const received: InboundEmail[] = []
  await using t = await mailApp(received).test({ database: { schema: 'push' } })
  expect(t.app.messaging.inbox.receiving).toBe(false)
  const body = JSON.stringify(delivery())
  const response = await post(
    t.app.handler,
    body,
    await signInboundPayload(SECRET, body),
  )
  expect(response.status).toBe(401)
})

test('tests deliver mail with t.messaging.<channel>.receive', async () => {
  const received: InboundEmail[] = []
  await using t = await mailApp(received).test({ database: { schema: 'push' } })
  const first = await t.messaging.inbox.receive({
    from: 'Rita <recruiter@acme.example>',
    to: 'anna.ivanova@mail.example.com',
    subject: 'Interview',
    text: 'Monday?',
    providerId: 'repeat-me',
  })
  expect(first.duplicate).toBe(false)
  expect(
    (
      await t.messaging.inbox.receive({
        from: 'recruiter@acme.example',
        to: 'anna.ivanova@mail.example.com',
        providerId: 'repeat-me',
      })
    ).duplicate,
  ).toBe(true)
  await t.jobs.runUntilIdle()
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({
    from: { address: 'recruiter@acme.example', name: 'Rita' },
    subject: 'Interview',
    text: 'Monday?',
  })
  expect(new TextDecoder().decode(await received[0]!.raw())).toContain(
    'Subject: Interview',
  )
  await expect(
    t.messaging.email.receive({ from: 'a@b.example', to: 'c@d.example' }),
  ).rejects.toThrow('does not receive mail')
})

test('a receiving channel needs exactly one handler, and a handler a receiving channel', () => {
  const base = { schema: { notes }, database: { adapter: libsql() } }
  expect(() =>
    bunderstack({
      ...base,
      messaging: { inbox: ses({ receive: true }) },
    }).inspect({ env: {} }),
  ).toThrow("no jobs.inbound('inbox', …) handles it")
  expect(() =>
    bunderstack({
      ...base,
      messaging: { inbox: ses() },
      jobs: (jobs) =>
        jobs.define({ fileMail: jobs.inbound('inbox', { handler: () => {} }) }),
    }).inspect({ env: {} }),
  ).toThrow('does not receive mail')
  expect(() =>
    bunderstack({
      ...base,
      messaging: { inbox: ses({ receive: true }) },
      jobs: (jobs) =>
        jobs.define({
          one: jobs.inbound('inbox', { handler: () => {} }),
          two: jobs.inbound('inbox', { handler: () => {} }),
        }),
    }).inspect({ env: {} }),
  ).toThrow('more than one jobs.inbound handler')

  const manifest = mailApp([]).inspect({ env: {} })
  expect(manifest.messaging.channels).toEqual([
    { name: 'email', kind: 'email', provider: 'ses' },
    { name: 'inbox', kind: 'email', provider: 'ses', receive: true },
  ])
})

test('signatures bind the body and the time', async () => {
  const body = '{"id":"x"}'
  const now = Date.parse('2026-11-02T10:00:00Z')
  const header = await signInboundPayload(SECRET, body, now)
  expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  expect(await verifyInboundSignature(header, body, [SECRET], now)).toBe(true)
  expect(await verifyInboundSignature(header, `${body} `, [SECRET], now)).toBe(
    false,
  )
  expect(
    await verifyInboundSignature(header, body, ['other', SECRET], now),
  ).toBe(true)
  expect(
    await verifyInboundSignature(header, body, [SECRET], now + 301_000),
  ).toBe(false)
  expect(await verifyInboundSignature('v1=abc', body, [SECRET], now)).toBe(
    false,
  )
})
