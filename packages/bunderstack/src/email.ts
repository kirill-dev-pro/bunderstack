// src/email.ts — email sending: resend / smtp / console / custom adapter.

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

export type SentEmail = { id?: string }

/** Adapters receive the message with `from` already resolved. */
export type EmailAdapter = {
  send(msg: EmailMessage & { from: string }): Promise<SentEmail>
}

export type EmailConfigInput = {
  from: string
  provider?: 'resend' | 'smtp' | 'console' | EmailAdapter | EmailAdapter['send']
}

export type EmailFacade = {
  send(msg: EmailMessage): Promise<SentEmail>
}

export type CreateEmailOptions = {
  env: { RESEND_API_KEY?: string; SMTP_URL?: string; NODE_ENV?: string }
  /** Test seam for the resend adapter. */
  fetchFn?: typeof fetch
  /** Test seam for the nodemailer presence check. */
  canResolveModule?: (specifier: string) => boolean
}

/** String provider tag ('resend' | 'smtp' | 'console') or undefined. */
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
      return {}
    },
  }
}

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
        }),
      })
      if (!res.ok) {
        throw new Error(`resend API error (${res.status}): ${await res.text()}`)
      }
      const data = (await res.json()) as { id?: string }
      return { id: data.id }
    },
  }
}

function createSmtpAdapter(
  smtpUrl: string,
  canResolve: (specifier: string) => boolean,
): EmailAdapter {
  if (!canResolve('nodemailer')) {
    throw new Error(
      "email provider 'smtp' requires nodemailer — install it with: bun add nodemailer",
    )
  }
  // Lazy import so boot stays sync; cached across sends. Variable specifier
  // keeps TS from resolving the optional peer's types at compile time.
  const specifier = 'nodemailer'
  let transportPromise: Promise<{
    sendMail(opts: Record<string, unknown>): Promise<{ messageId?: string }>
  }> | null = null
  const getTransport = () => {
    transportPromise ??= import(specifier).then((mod) =>
      (mod.default ?? mod).createTransport(smtpUrl),
    )
    return transportPromise
  }
  return {
    async send(msg) {
      const transport = await getTransport()
      const info = await transport.sendMail({
        from: msg.from,
        to: toArray(msg.to)!.join(', '),
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
        cc: toArray(msg.cc)?.join(', '),
        bcc: toArray(msg.bcc)?.join(', '),
      })
      return { id: info.messageId }
    },
  }
}

function defaultCanResolve(specifier: string): boolean {
  try {
    Bun.resolveSync(specifier, import.meta.dir)
    return true
  } catch {
    return false
  }
}

function resolveAdapter(
  config: EmailConfigInput,
  opts: CreateEmailOptions,
): EmailAdapter {
  const provider = config.provider
  if (typeof provider === 'function') return { send: provider }
  if (typeof provider === 'object') return provider
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis)
  switch (provider) {
    case 'resend':
      return createResendAdapter(opts.env.RESEND_API_KEY ?? '', fetchFn)
    case 'smtp':
      return createSmtpAdapter(
        opts.env.SMTP_URL ?? '',
        opts.canResolveModule ?? defaultCanResolve,
      )
    case 'console':
      return createConsoleAdapter()
    case undefined:
      if (opts.env.NODE_ENV === 'production') {
        throw new Error(
          'email is configured without a provider — set email.provider ' +
            "('resend' | 'smtp' | a custom adapter) for production",
        )
      }
      return createConsoleAdapter()
  }
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
  const adapter = resolveAdapter(config, opts)
  return {
    async send(msg) {
      if (!msg.html && !msg.text) {
        throw new Error('email message needs html or text content')
      }
      return adapter.send({ ...msg, from: msg.from ?? config.from })
    },
  }
}
