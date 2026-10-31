import { expect, mock, test } from 'bun:test'

import { resend, ses } from './email'
import { createMessaging } from './runtime'

const env = {
  DATABASE_URL: ':memory:',
  AUTH_SECRET: 'test',
  BUNDERSTACK_ROLE: 'web' as const,
}

const managed = {
  ses: {
    region: 'eu-west-1',
    accessKeyId: 'AKIDMANAGED',
    secretAccessKey: 'managed-secret',
    configurationSet: 'bunderhost',
    tenant: 'bh-project',
    inbound: { secret: 's', channels: { inbox: ['mail.example.com'] } },
  },
}

function sesFetch(messageId = '0102018f-abc') {
  const requests: Request[] = []
  const fetchFn = mock(async (input: RequestInfo | URL) => {
    requests.push(input as Request)
    return Response.json({ MessageId: messageId })
  })
  return { requests, fetchFn }
}

test('SES sends a signed SendEmail with headers, tags, configuration set and tenant', async () => {
  const { requests, fetchFn } = sesFetch()
  const messaging = createMessaging(
    { inbox: ses({ receive: true }) },
    {
      env: {
        ...env,
        BUNDERHOST_ENVIRONMENT_ID: 'env_1',
        BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify(managed),
      },
      fetchFn: fetchFn as never,
    },
  )
  const sent = await messaging.inbox.send({
    from: 'anna.ivanova@mail.example.com',
    to: 'recruiter@acme.example',
    cc: ['team@acme.example'],
    subject: 'Re: Interview',
    text: 'Monday works.',
    html: '<p>Monday works.</p>',
    replyTo: 'anna.ivanova@mail.example.com',
    headers: {
      'In-Reply-To': '<m1@acme.example>',
      References: '<m0@acme.example> <m1@acme.example>',
    },
  })
  expect(sent.messageId).toBe('<0102018f-abc@eu-west-1.amazonses.com>')
  expect(sent.providerId).toBe('0102018f-abc')

  const [request] = requests
  expect(request!.url).toBe(
    'https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails',
  )
  expect(request!.method).toBe('POST')
  expect(request!.headers.get('authorization')).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIDMANAGED\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
  )
  const body = await request!.json()
  expect(body).toEqual({
    FromEmailAddress: 'anna.ivanova@mail.example.com',
    Destination: {
      ToAddresses: ['recruiter@acme.example'],
      CcAddresses: ['team@acme.example'],
    },
    ReplyToAddresses: ['anna.ivanova@mail.example.com'],
    Content: {
      Simple: {
        Subject: { Data: 'Re: Interview', Charset: 'UTF-8' },
        Body: {
          Html: { Data: '<p>Monday works.</p>', Charset: 'UTF-8' },
          Text: { Data: 'Monday works.', Charset: 'UTF-8' },
        },
        Headers: [
          { Name: 'In-Reply-To', Value: '<m1@acme.example>' },
          { Name: 'References', Value: '<m0@acme.example> <m1@acme.example>' },
        ],
      },
    },
    EmailTags: [
      { Name: 'bunderstack_message_id', Value: sent.id },
      { Name: 'bunderhost_environment_id', Value: 'env_1' },
    ],
    ConfigurationSetName: 'bunderhost',
    TenantName: 'bh-project',
  })
})

test('a channel without a sender needs one per message', async () => {
  const { fetchFn } = sesFetch()
  const messaging = createMessaging(
    { inbox: ses({ receive: true }) },
    {
      env: { ...env, BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify(managed) },
      fetchFn: fetchFn as never,
    },
  )
  await expect(
    messaging.inbox.send({ to: 'a@example.com', subject: 'Hi', text: 'x' }),
  ).rejects.toThrow('has no from address')
  expect(fetchFn).not.toHaveBeenCalled()
})

test('SES without credentials captures, like every channel', async () => {
  const { fetchFn } = sesFetch()
  const messaging = createMessaging(
    { email: ses({ from: 'app@example.com' }) },
    {
      env: { ...env, BUNDERHOST_ENVIRONMENT_ID: 'env_1' },
      fetchFn: fetchFn as never,
    },
  )
  const sent = await messaging.email.send({
    to: 'a@example.com',
    subject: 'Hi',
    text: 'x',
  })
  expect(sent.providerId).toBeUndefined()
  expect(fetchFn).not.toHaveBeenCalled()
  expect(messaging.email.receiving).toBe(false)
})

test('headers that have their own field, or span lines, are refused', async () => {
  const { fetchFn } = sesFetch()
  const messaging = createMessaging(
    { email: ses({ from: 'app@example.com' }) },
    {
      env: { ...env, BUNDERSTACK_MESSAGING_CONFIG: JSON.stringify(managed) },
      fetchFn: fetchFn as never,
    },
  )
  const message = { to: 'a@example.com', subject: 'Hi', text: 'x' }
  await expect(
    messaging.email.send({ ...message, headers: { Subject: 'Other' } }),
  ).rejects.toThrow('has its own field')
  await expect(
    messaging.email.send({
      ...message,
      headers: { 'X-Note': 'one\r\nBcc: someone@example.com' },
    }),
  ).rejects.toThrow('single-line')
  expect(fetchFn).not.toHaveBeenCalled()
})

test('hosted Resend sends carry the tags delivery events are matched by', async () => {
  const calls: RequestInit[] = []
  const fetchFn = mock(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init!)
      return Response.json({ id: 're_1' })
    },
  )
  const resendManaged = JSON.stringify({
    resend: { apiKey: 'managed', from: 'app@example.com' },
  })
  const hosted = createMessaging(
    { email: resend() },
    {
      env: {
        ...env,
        BUNDERHOST_ENVIRONMENT_ID: 'env_1',
        BUNDERSTACK_MESSAGING_CONFIG: resendManaged,
      },
      fetchFn: fetchFn as never,
    },
  )
  const sent = await hosted.email.send({
    to: 'a@example.com',
    subject: 'Hi',
    text: 'x',
    headers: { 'X-Entity-Ref-ID': 'abc' },
  })
  const body = JSON.parse(calls[0]!.body as string)
  expect(body.tags).toEqual([
    { name: 'bunderstack_message_id', value: sent.id },
    { name: 'bunderhost_environment_id', value: 'env_1' },
  ])
  expect(body.headers).toEqual({ 'X-Entity-Ref-ID': 'abc' })

  const local = createMessaging(
    { email: resend() },
    {
      env: { ...env, BUNDERSTACK_MESSAGING_CONFIG: resendManaged },
      fetchFn: fetchFn as never,
    },
  )
  await local.email.send({ to: 'a@example.com', subject: 'Hi', text: 'x' })
  expect(JSON.parse(calls[1]!.body as string).tags).toBeUndefined()
})
