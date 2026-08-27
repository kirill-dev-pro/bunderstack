// src/email.ts — email sending: console / resend / custom adapters.
// SMTP is provided by the static `bunderstack/email/smtp` factory subpath.

import { and, eq } from 'drizzle-orm'

import type { AnyDb } from './dialect'

import { emailsTableFor } from './internal-tables'

export type EmailMessage = {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
}

export type SentEmail = { id?: string; providerId?: string }

type AdapterSentEmail = { id?: string }

/** Adapters receive the message with `from` already resolved. */
export type EmailAdapter = {
  send(msg: EmailMessage & { from: string }): Promise<AdapterSentEmail>
}

export type EmailConfigInput = {
  from: string
  provider?: 'resend' | 'console' | EmailAdapter | EmailAdapter['send']
}

export type EmailFacade = {
  send(msg: EmailMessage): Promise<SentEmail>
}

export type CreateEmailOptions = {
  env: {
    RESEND_API_KEY?: string
    SMTP_URL?: string
    NODE_ENV?: string
    BUNDERSTACK_EMAIL_PROVIDER?: string
    BUNDERSTACK_EMAIL_FROM?: string
    BUNDERHOST_ENVIRONMENT_ID?: string
  }
  /** Internal application db. Present when created through createBunderstack. */
  db?: AnyDb
  /** Test seam for the resend adapter. */
  fetchFn?: typeof fetch
  /** Internal runtime substitution used by isolated test fixtures. */
  adapterOverride?: EmailAdapter
}

/** Root string provider tag ('resend' | 'console') or undefined. */
export function emailProviderTag(
  config: EmailConfigInput | undefined,
): string | undefined {
  return typeof config?.provider === 'string' ? config.provider : undefined
}

const toArray = (v: string | string[] | undefined) =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v]

function createConsoleAdapter(): EmailAdapter {
  return {
    async send(msg) {
      const line = '─'.repeat(60)
      console.log(
        [
          line,
          '📧 email (console provider — not sent)',
          `from:    ${msg.from}`,
          `to:      ${toArray(msg.to)!.join(', ')}`,
          `subject: ${msg.subject}`,
          line,
          msg.text ?? msg.html ?? '',
          line,
        ].join('\n'),
      )
      return { id: '' }
    },
  }
}

const captureAdapter: EmailAdapter = { send: async () => ({}) }

function createResendAdapter(
  apiKey: string,
  fetchFn: typeof fetch,
): EmailAdapter {
  return {
    async send(msg) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: msg.from,
          to: toArray(msg.to),
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
          cc: toArray(msg.cc),
          bcc: toArray(msg.bcc),
          tags: (msg as EmailMessage & { tags?: unknown }).tags,
        }),
      })
      if (!res.ok) {
        throw new Error(`resend API error (${res.status}): ${await res.text()}`)
      }
      const data = (await res.json()) as { id?: string }
      return { id: data.id ?? '' }
    },
  }
}

function resolveAdapter(
  config: EmailConfigInput,
  opts: CreateEmailOptions,
): { adapter: EmailAdapter; provider: string; capture: boolean } {
  if (opts.adapterOverride) {
    return {
      adapter: opts.adapterOverride,
      provider: 'capture',
      capture: true,
    }
  }
  const managedProvider = opts.env.BUNDERSTACK_EMAIL_PROVIDER
  const provider = managedProvider === 'resend' ? 'resend' : config.provider
  if (typeof provider === 'function') {
    return { adapter: { send: provider }, provider: 'custom', capture: false }
  }
  if (typeof provider === 'object') {
    return { adapter: provider, provider: 'custom', capture: false }
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis)
  switch (provider) {
    case 'resend':
      return {
        adapter: createResendAdapter(opts.env.RESEND_API_KEY ?? '', fetchFn),
        provider: 'resend',
        capture: false,
      }

    case 'console':
      return {
        adapter: createConsoleAdapter(),
        provider: 'capture',
        capture: true,
      }
    case undefined:
      return {
        adapter:
          opts.env.NODE_ENV === 'production'
            ? captureAdapter
            : createConsoleAdapter(),
        provider: 'capture',
        capture: true,
      }
    default:
      if (provider === 'smtp') {
        throw new Error(
          "email provider 'smtp' was removed. Import `smtp` from 'bunderstack/email/smtp' instead.",
        )
      }
      return {
        adapter: createConsoleAdapter(),
        provider: 'capture',
        capture: true,
      }
  }
}

async function insertJournal(
  db: AnyDb | undefined,
  value: Record<string, unknown>,
) {
  if (!db) return
  const table = emailsTableFor(db)
  await db.insert(table).values(value)
}

async function updateJournal(
  db: AnyDb | undefined,
  id: string,
  value: Record<string, unknown>,
  expectedStatus?: string,
) {
  if (!db) return
  const table = emailsTableFor(db)
  await db
    .update(table)
    .set(value)
    .where(
      expectedStatus
        ? and(eq(table.id, id), eq(table.status, expectedStatus))
        : eq(table.id, id),
    )
}

export function createEmail(
  config: EmailConfigInput | undefined,
  opts: CreateEmailOptions,
): EmailFacade {
  if (!config) {
    return {
      async send() {
        throw new Error(
          'email is not configured — add an email key to your bunderstack config',
        )
      },
    }
  }
  const resolved = resolveAdapter(config, opts)
  return {
    async send(msg) {
      if (!msg.html && !msg.text) {
        throw new Error('email message needs html or text content')
      }
      const id = `email_${crypto.randomUUID()}`
      const now = Date.now()
      const from = opts.env.BUNDERSTACK_EMAIL_FROM ?? msg.from ?? config.from
      await insertJournal(opts.db, {
        id,
        provider: resolved.provider,
        status: resolved.capture ? 'captured' : 'sending',
        from,
        toJson: JSON.stringify(toArray(msg.to) ?? []),
        ccJson: JSON.stringify(toArray(msg.cc) ?? []),
        bccJson: JSON.stringify(toArray(msg.bcc) ?? []),
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        createdAt: now,
        updatedAt: now,
      })
      if (resolved.capture) {
        await resolved.adapter.send({ ...msg, from })
        return { id }
      }
      try {
        const tags = [
          { name: 'bunderstack_email_id', value: id },
          ...(opts.env.BUNDERHOST_ENVIRONMENT_ID
            ? [
                {
                  name: 'bunderhost_environment_id',
                  value: opts.env.BUNDERHOST_ENVIRONMENT_ID,
                },
              ]
            : []),
        ]
        const sent = await resolved.adapter.send({
          ...msg,
          from,
          tags,
        } as EmailMessage & {
          from: string
        })
        await updateJournal(
          opts.db,
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
        await updateJournal(
          opts.db,
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
  }
}
