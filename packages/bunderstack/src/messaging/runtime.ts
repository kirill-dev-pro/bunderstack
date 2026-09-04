import type { AnyDb } from '../dialect'
import type { EmailAdapter, EmailMessage } from '../email'
import type { BaseEnv } from '../env'
import type { TelegramMessage } from './telegram'
import type {
  AnyMessagingDescriptor,
  MessagingConfig,
  MessagingFacades,
} from './types'

import { insertMessage, updateMessage } from './journal'
import { isMessagingDescriptor } from './types'

export type MessagingAdapter = {
  send(input: any): Promise<{ id?: string }>
}

export type CreateMessagingOptions = {
  env: BaseEnv
  db?: AnyDb
  fetchFn?: typeof fetch
  adapterOverrides?: Record<string, MessagingAdapter>
}

type ManagedConfig = Record<string, Record<string, unknown>>
type CredentialSource = 'explicit' | 'managed' | 'capture'

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const array = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

function managedConfig(raw: string | undefined): ManagedConfig {
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
    },
  }
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
    async send(input: EmailMessage & { from: string; tags?: unknown }) {
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

function providerConfig(
  descriptor: AnyMessagingDescriptor,
  managed: ManagedConfig,
): Record<string, unknown> {
  const merged = { ...managed[descriptor.provider] }
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
    const merged = providerConfig(descriptor, managed)
    const override = options.adapterOverrides?.[channel]
    let adapter: MessagingAdapter | undefined = override
    let source: CredentialSource = override ? 'capture' : 'explicit'
    let from: string | undefined
    if (
      !adapter &&
      descriptor.kind === 'email' &&
      descriptor.provider === 'resend'
    ) {
      const own = descriptor.config as { apiKey?: string; from?: string }
      const apiKey = merged.apiKey
      from = nonEmpty(merged.from) ? merged.from : undefined
      if (nonEmpty(apiKey) && from) {
        source = nonEmpty(own.apiKey) ? 'explicit' : 'managed'
        adapter = createResendAdapter(apiKey, options.fetchFn ?? fetch)
      }
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

    return [
      channel,
      {
        async send(input: EmailMessage | TelegramMessage) {
          if (
            descriptor.kind === 'email' &&
            !(input as EmailMessage).html &&
            !(input as EmailMessage).text
          ) {
            throw new Error('email message needs html or text content')
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
            provider: descriptor.provider,
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
            const outgoing =
              descriptor.kind === 'email'
                ? { ...input, from: resolvedFrom }
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
            return { id, providerId: sent.id || undefined }
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
