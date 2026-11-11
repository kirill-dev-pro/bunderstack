import type { AnyDb } from '../dialect'
import type { EmailAdapter, EmailMessage } from '../email'
import type { BaseEnv } from '../env'
import type { TelegramMessage } from './telegram'
import type {
  AnyMessagingDescriptor,
  MessagingConfig,
  MessagingFacades,
} from './types'

import { EMAIL_PROVIDERS, type EmailProviderName } from './email'
import { insertMessage, updateMessage } from './journal'
import { createSesAdapter, type MessageTag } from './ses'
import { isMessagingDescriptor } from './types'

export type MessagingAdapter = {
  send(input: any): Promise<{ id?: string; messageId?: string }>
}

export type CreateMessagingOptions = {
  env: BaseEnv
  db?: AnyDb
  fetchFn?: typeof fetch
  adapterOverrides?: Record<string, MessagingAdapter>
}

export type ManagedConfig = Record<string, Record<string, unknown>>
type CredentialSource = 'explicit' | 'managed' | 'capture'

/**
 * Headers that have their own message field. Setting them through `headers`
 * would contradict the field, so they are refused rather than guessed at.
 */
const FIELD_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
])

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const array = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

export function managedConfig(raw: string | undefined): ManagedConfig {
  if (!nonEmpty(raw)) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(
      '[bunderstack] BUNDERSTACK_MESSAGING_CONFIG must be valid JSON',
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      '[bunderstack] BUNDERSTACK_MESSAGING_CONFIG must be an object',
    )
  }
  return value as ManagedConfig
}

function consoleCapture(channel: string, kind: string, input: unknown) {
  console.log(
    `\n${'─'.repeat(60)}\n` +
      `💬 ${channel} (${kind}, captured — not sent)\n` +
      `${'─'.repeat(60)}\n` +
      `${JSON.stringify(input, null, 2)}\n` +
      `${'─'.repeat(60)}`,
  )
}

function emailContent(input: EmailMessage, from: string) {
  return {
    recipients: {
      to: array(input.to),
      cc: array(input.cc),
      bcc: array(input.bcc),
    },
    content: {
      subject: input.subject,
      html: input.html,
      text: input.text,
      from,
      replyTo: input.replyTo,
      headers: input.headers,
    },
  }
}

function assertHeaders(headers: Record<string, string> | undefined) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (FIELD_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `email header "${name}" has its own field; set it there instead of in headers`,
      )
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new Error(`email header "${name}" must be a single-line string`)
    }
  }
}

/**
 * How Bunderhost finds the journal row of a delivery event: the message's own
 * id and the environment that sent it. Only a hosted process tags; locally
 * there is no one to read the events.
 */
function deliveryTags(id: string, env: BaseEnv): MessageTag[] | undefined {
  const environmentId = env.BUNDERHOST_ENVIRONMENT_ID
  if (!nonEmpty(environmentId)) return undefined
  return [
    { name: 'bunderstack_message_id', value: id },
    { name: 'bunderhost_environment_id', value: environmentId },
  ]
}

/**
 * The receiving side of a channel: Bunderhost puts the signing secret and the
 * verified domains routed to each channel under `<provider>.inbound`.
 */
export function receivingFor(
  channel: string,
  descriptor: AnyMessagingDescriptor,
  managed: ManagedConfig,
): { provider: string; secret: string | undefined; domains: string[] } {
  const declared =
    descriptor.kind === 'email' &&
    (descriptor.config as { receive?: boolean }).receive === true
  const provider = receiveProvider(descriptor, managed)
  const inbound = managed[provider]?.inbound as
    | { secret?: unknown; channels?: Record<string, unknown> }
    | undefined
  const secret = nonEmpty(inbound?.secret) ? inbound.secret : undefined
  const listed = inbound?.channels?.[channel]
  const domains =
    declared && secret && Array.isArray(listed) ? listed.filter(nonEmpty) : []
  return { provider, secret: declared ? secret : undefined, domains }
}

function telegramContent(input: TelegramMessage) {
  return {
    recipients: { to: [String(input.to)] },
    content: { text: input.text, parseMode: input.parseMode },
  }
}

function createResendAdapter(
  apiKey: string,
  fetchFn: typeof fetch,
): MessagingAdapter {
  return {
    async send(input: EmailMessage & { from: string; tags?: MessageTag[] }) {
      const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: input.from,
          to: array(input.to),
          subject: input.subject,
          html: input.html,
          text: input.text,
          reply_to: input.replyTo,
          cc: array(input.cc),
          bcc: array(input.bcc),
          headers: input.headers,
          tags: input.tags,
        }),
      })
      if (!response.ok) {
        throw new Error(
          `resend API error (${response.status}): ${await response.text()}`,
        )
      }
      return (await response.json()) as { id?: string }
    },
  }
}

function createTelegramAdapter(
  token: string,
  fetchFn: typeof fetch,
): MessagingAdapter {
  return {
    async send(input: TelegramMessage) {
      const response = await fetchFn(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: input.to,
            text: input.text,
            parse_mode: input.parseMode,
          }),
        },
      )
      if (!response.ok) {
        throw new Error(
          `telegram API error (${response.status}): ${await response.text()}`,
        )
      }
      const body = (await response.json()) as {
        result?: { message_id?: number }
      }
      return { id: body.result?.message_id?.toString() }
    },
  }
}

/**
 * The host's choice for managed `email()` channels:
 * `BUNDERSTACK_MESSAGING_CONFIG.email = { send, receive? }`.
 */
function managedEmailChoice(managed: ManagedConfig): {
  send: string | undefined
  receive: string | undefined
} {
  const choice = managed.email
  const send = nonEmpty(choice?.send) ? choice.send : undefined
  const receive = nonEmpty(choice?.receive) ? choice.receive : send
  return { send, receive }
}

/**
 * The provider a channel sends through: its own for a pinned channel, the
 * host's choice for a managed one, or `managed` when the host chose nothing.
 */
export function sendProvider(
  descriptor: AnyMessagingDescriptor,
  managed: ManagedConfig,
): string {
  if (descriptor.kind !== 'email' || descriptor.provider !== 'managed') {
    return descriptor.provider
  }
  return managedEmailChoice(managed).send ?? 'managed'
}

function receiveProvider(
  descriptor: AnyMessagingDescriptor,
  managed: ManagedConfig,
): string {
  if (descriptor.kind !== 'email' || descriptor.provider !== 'managed') {
    return descriptor.provider
  }
  return managedEmailChoice(managed).receive ?? 'managed'
}

type EmailSender = {
  adapter: MessagingAdapter
  /** The channel brought its own credential rather than the host's. */
  explicit: boolean
  /** The sender may come with each message instead of the channel. */
  senderPerMessage: boolean
  /** Messages carry the tags the host matches delivery events with. */
  tagged: boolean
}

type EmailProvider = (args: {
  merged: Record<string, unknown>
  own: Record<string, unknown>
  from: string | undefined
  fetchFn: typeof fetch
}) => EmailSender | undefined

/**
 * Every provider a channel can send email through. A pinned helper names
 * one directly; a managed `email()` channel is routed to one by the host.
 * Adding a provider is an entry here, its adapter, and its name in
 * `EMAIL_PROVIDERS`.
 */
const EMAIL_SENDERS: Record<EmailProviderName, EmailProvider> = {
  resend({ merged, own, from, fetchFn }) {
    const apiKey = merged.apiKey
    if (!nonEmpty(apiKey) || !from) return undefined
    return {
      adapter: createResendAdapter(apiKey, fetchFn),
      explicit: nonEmpty(own.apiKey),
      senderPerMessage: false,
      tagged: true,
    }
  },
  ses({ merged, own, fetchFn }) {
    // A receiving channel usually answers from the address that was
    // written to, so its sender can come with each message instead.
    const { region, accessKeyId, secretAccessKey } = merged
    if (
      !nonEmpty(region) ||
      !nonEmpty(accessKeyId) ||
      !nonEmpty(secretAccessKey)
    ) {
      return undefined
    }
    return {
      adapter: createSesAdapter(
        {
          region,
          accessKeyId,
          secretAccessKey,
          configurationSet: nonEmpty(merged.configurationSet)
            ? merged.configurationSet
            : undefined,
          tenant: nonEmpty(merged.tenant) ? merged.tenant : undefined,
        },
        fetchFn,
      ),
      explicit: nonEmpty(own.accessKeyId),
      senderPerMessage: true,
      tagged: true,
    }
  },
}

function isEmailProvider(name: string): name is EmailProviderName {
  return (EMAIL_PROVIDERS as readonly string[]).includes(name)
}

/**
 * The provider's managed config, then the host's sender for this channel
 * (`email.channels.<name>.from`, managed channels only), then what the
 * channel declares itself, each winning over the one before.
 */
function providerConfig(
  channel: string,
  descriptor: AnyMessagingDescriptor,
  provider: string,
  managed: ManagedConfig,
): Record<string, unknown> {
  const merged = { ...managed[provider] }
  if (descriptor.kind === 'email' && descriptor.provider === 'managed') {
    const channels = managed.email?.channels as
      | Record<string, { from?: unknown } | undefined>
      | undefined
    const from = channels?.[channel]?.from
    if (nonEmpty(from)) merged.from = from
  }
  for (const [key, value] of Object.entries(
    descriptor.config as Record<string, unknown>,
  )) {
    if (typeof value === 'string' ? nonEmpty(value) : value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

export function createMessaging<const TConfig extends MessagingConfig>(
  config: TConfig,
  options: CreateMessagingOptions,
): MessagingFacades<TConfig> {
  const managed = managedConfig(options.env.BUNDERSTACK_MESSAGING_CONFIG)
  const entries = Object.entries(config).map(([channel, descriptor]) => {
    if (!channel.trim())
      throw new Error('[bunderstack] messaging channel names cannot be empty')
    if (!isMessagingDescriptor(descriptor)) {
      throw new Error(
        `[bunderstack] messaging.${channel} is not a provider descriptor`,
      )
    }
    const provider = sendProvider(descriptor, managed)
    if (
      descriptor.provider === 'managed' &&
      provider !== 'managed' &&
      !isEmailProvider(provider)
    ) {
      throw new Error(
        `[bunderstack] messaging.${channel}: the host routes email to "${provider}", ` +
          `which this version of bunderstack cannot send through (it knows ${EMAIL_PROVIDERS.join(', ')}); upgrade bunderstack`,
      )
    }
    const merged = providerConfig(channel, descriptor, provider, managed)
    const override = options.adapterOverrides?.[channel]
    let adapter: MessagingAdapter | undefined = override
    let source: CredentialSource = override ? 'capture' : 'explicit'
    let from: string | undefined
    let senderPerMessage = false
    let tagged = false
    if (!adapter && descriptor.kind === 'email' && isEmailProvider(provider)) {
      from = nonEmpty(merged.from) ? merged.from : undefined
      const sender = EMAIL_SENDERS[provider]({
        merged,
        own: descriptor.config as Record<string, unknown>,
        from,
        fetchFn: options.fetchFn ?? fetch,
      })
      if (sender) {
        adapter = sender.adapter
        source = sender.explicit ? 'explicit' : 'managed'
        senderPerMessage = sender.senderPerMessage
        tagged = sender.tagged
      }
    } else if (
      !adapter &&
      descriptor.kind === 'email' &&
      provider === 'managed'
    ) {
      // The host chose no provider: capture.
      from = nonEmpty(merged.from) ? merged.from : undefined
    } else if (!adapter && descriptor.kind === 'email') {
      const own = descriptor.config as {
        adapter?: EmailAdapter | EmailAdapter['send']
        from?: string
      }
      from = nonEmpty(merged.from) ? merged.from : undefined
      if (own.adapter && from) {
        adapter =
          typeof own.adapter === 'function'
            ? { send: own.adapter }
            : own.adapter
      }
    } else if (!adapter && descriptor.kind === 'telegram') {
      const own = descriptor.config as { botToken?: string }
      const token = merged.botToken
      if (nonEmpty(token)) {
        source = nonEmpty(own.botToken) ? 'explicit' : 'managed'
        adapter = createTelegramAdapter(token, options.fetchFn ?? fetch)
      }
    }
    const capture = !adapter || Boolean(override)
    if (capture) source = 'capture'
    const receiving =
      descriptor.kind === 'email'
        ? receivingFor(channel, descriptor, managed)
        : undefined
    const domains = Object.freeze([...(receiving?.domains ?? [])])

    return [
      channel,
      {
        ...(descriptor.kind === 'email'
          ? { receiving: domains.length > 0, domains }
          : {}),
        async send(input: EmailMessage | TelegramMessage) {
          if (descriptor.kind === 'email') {
            const email = input as EmailMessage
            if (!email.html && !email.text) {
              throw new Error('email message needs html or text content')
            }
            assertHeaders(email.headers)
            if (!capture && senderPerMessage && !email.from && !from) {
              throw new Error(
                `messaging.${channel}: the message has no from address and the channel declares none`,
              )
            }
          }
          const resolvedFrom =
            descriptor.kind === 'email'
              ? ((input as EmailMessage).from ?? from ?? 'unknown@localhost')
              : undefined
          const normalized =
            descriptor.kind === 'email'
              ? emailContent(input as EmailMessage, resolvedFrom!)
              : telegramContent(input as TelegramMessage)
          const id = `message_${crypto.randomUUID()}`
          const now = Date.now()
          await insertMessage(options.db, {
            id,
            channel,
            kind: descriptor.kind,
            provider,
            credentialSource: source,
            status: capture ? 'captured' : 'sending',
            recipientsJson: JSON.stringify(normalized.recipients),
            contentJson: JSON.stringify(normalized.content),
            createdAt: now,
            updatedAt: now,
          })
          if (capture) {
            await adapter?.send(input)
            if (!override && !options.env.BUNDERHOST_ENVIRONMENT_ID) {
              consoleCapture(channel, descriptor.kind, input)
            }
            return { id }
          }
          try {
            const tags = tagged ? deliveryTags(id, options.env) : undefined
            const outgoing =
              descriptor.kind === 'email'
                ? { ...input, from: resolvedFrom, ...(tags ? { tags } : {}) }
                : input
            const sent = await adapter!.send(outgoing)
            await updateMessage(
              options.db,
              id,
              {
                providerId: sent.id || undefined,
                status: 'sent',
                updatedAt: Date.now(),
              },
              'sending',
            )
            return {
              id,
              providerId: sent.id || undefined,
              ...(sent.messageId ? { messageId: sent.messageId } : {}),
            }
          } catch (error) {
            await updateMessage(
              options.db,
              id,
              {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                updatedAt: Date.now(),
              },
              'sending',
            )
            throw error
          }
        },
      },
    ]
  })
  return Object.fromEntries(entries) as MessagingFacades<TConfig>
}
