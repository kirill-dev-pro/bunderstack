import type { MessagingConfig } from '../messaging'
import type {
  InboundAttachment,
  InboundPayload,
  InboundVerdicts,
} from '../messaging/inbound'
import type { MessagingAdapter } from '../messaging/runtime'
import type { TestEmail } from './email'

import { createTestEmail } from './email'

export type TestMessagingChannel<TInput = unknown> = {
  readonly sent: readonly Readonly<TInput>[]
}

/**
 * A message to deliver to a receiving channel. Only `from` and `to` are
 * required; addresses may carry a display name (`Ann <ann@example.com>`).
 */
export type TestInboundEmail = {
  from: string
  /** Envelope recipients: the channel's own addresses the message was for. */
  to: string | string[]
  cc?: string | string[]
  replyTo?: string | string[]
  subject?: string
  text?: string
  html?: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  date?: Date
  headers?: Record<string, string>
  attachments?: InboundAttachment[]
  verdicts?: Partial<InboundVerdicts>
  /** What `raw()` returns; a minimal MIME message is built when absent. */
  raw?: string | Uint8Array
  /** The provider's id; repeat it to test a repeated delivery. */
  providerId?: string
}

export type TestReceivingChannel = {
  /**
   * Delivers a message as the host would and enqueues the channel's
   * `jobs.inbound` handler. Run it with `t.jobs`.
   */
  receive(
    message: TestInboundEmail,
  ): Promise<{ id: string; duplicate: boolean }>
}

type SendInput<T> = T extends { send(input: infer TInput): unknown }
  ? TInput
  : never

export type TestMessagingForApp<TApp> = TApp extends {
  messaging: infer TMessaging extends Record<string, unknown>
}
  ? {
      readonly [K in keyof TMessaging]: TestMessagingChannel<
        SendInput<TMessaging[K]>
      > &
        (TMessaging[K] extends { readonly receiving: boolean }
          ? TestReceivingChannel
          : unknown)
    }
  : Record<never, never>

type Receiver = (
  payload: unknown,
) => Promise<{ id: string; duplicate: boolean }>

const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

const ADDRESS = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/

function parseAddress(value: string): { address: string; name?: string } {
  const match = ADDRESS.exec(value)
  if (!match) return { address: value.trim() }
  const name = match[1]?.trim()
  return name
    ? { address: match[2]!.trim(), name }
    : { address: match[2]!.trim() }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function minimalMime(message: TestInboundEmail, messageId: string): string {
  const lines = [
    `From: ${message.from}`,
    `To: ${list(message.to).join(', ')}`,
    `Subject: ${message.subject ?? ''}`,
    `Message-ID: ${messageId}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references?.length
      ? [`References: ${message.references.join(' ')}`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.text ?? '',
  ]
  return lines.join('\r\n')
}

let sequence = 0

export function testInboundPayload(
  channel: string,
  message: TestInboundEmail,
): InboundPayload {
  sequence += 1
  const providerId = message.providerId ?? `test-inbound-${sequence}`
  const messageId = message.messageId ?? `<${providerId}@test.local>`
  const raw =
    typeof message.raw === 'string'
      ? new TextEncoder().encode(message.raw)
      : (message.raw ??
        new TextEncoder().encode(minimalMime(message, messageId)))
  const to = list(message.to)
  const headers = [
    { name: 'From', value: message.from },
    { name: 'To', value: to.join(', ') },
    { name: 'Subject', value: message.subject ?? '' },
    { name: 'Message-ID', value: messageId },
    ...(message.inReplyTo
      ? [{ name: 'In-Reply-To', value: message.inReplyTo }]
      : []),
    ...(message.references?.length
      ? [{ name: 'References', value: message.references.join(' ') }]
      : []),
    ...Object.entries(message.headers ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  ]
  return {
    id: providerId,
    channel,
    receivedAt: new Date().toISOString(),
    envelope: { from: parseAddress(message.from).address, to },
    verdicts: {
      spf: 'PASS',
      dkim: 'PASS',
      dmarc: 'PASS',
      spam: 'PASS',
      virus: 'PASS',
      ...message.verdicts,
    },
    message: {
      messageId,
      inReplyTo: message.inReplyTo ?? null,
      references: message.references ?? [],
      date: (message.date ?? new Date()).toISOString(),
      subject: message.subject ?? '',
      from: parseAddress(message.from),
      to: to.map(parseAddress),
      cc: list(message.cc).map(parseAddress),
      replyTo: list(message.replyTo).map(parseAddress),
      text: message.text ?? null,
      html: message.html ?? null,
      truncated: false,
      headers,
      attachments: message.attachments ?? [],
    },
    raw: {
      url: `data:message/rfc822;base64,${base64(raw)}`,
      size: raw.byteLength,
    },
  }
}

export function createTestMessaging(config: MessagingConfig | undefined): {
  adapters: Record<string, MessagingAdapter>
  messaging: Record<string, TestMessagingChannel>
  authEmail: TestEmail
  /** Connects `receive` to the started app. */
  bindReceiver(receiver: Receiver): void
} {
  const adapters: Record<string, MessagingAdapter> = {}
  const messaging: Record<string, TestMessagingChannel> = {}
  let authEmail: TestEmail | undefined
  let receiver: Receiver | undefined

  for (const [channel, descriptor] of Object.entries(config ?? {})) {
    if (descriptor.kind === 'email') {
      const capture = createTestEmail()
      adapters[channel] = capture.adapter
      const receiving =
        (descriptor.config as { receive?: boolean }).receive === true
      const channelHandle: TestMessagingChannel & TestReceivingChannel = {
        get sent() {
          return capture.email.sent
        },
        async receive(message) {
          if (!receiving) {
            throw new Error(
              `[bunderstack] messaging.${channel} does not receive mail — declare it with receive: true`,
            )
          }
          if (!receiver) {
            throw new Error('[bunderstack] the test app is not started yet')
          }
          return receiver(testInboundPayload(channel, message))
        },
      }
      messaging[channel] = channelHandle
      if (channel === 'email') authEmail = capture.email
      continue
    }
    const messages: unknown[] = []
    adapters[channel] = {
      async send(input) {
        messages.push(structuredClone(input))
        return { id: `test-${channel}-${messages.length}` }
      },
    }
    messaging[channel] = {
      get sent() {
        return Object.freeze(
          messages.map((message) => Object.freeze(structuredClone(message))),
        )
      },
    }
  }

  return {
    adapters,
    messaging,
    authEmail: authEmail ?? createTestEmail().email,
    bindReceiver(next) {
      receiver = next
    },
  }
}
