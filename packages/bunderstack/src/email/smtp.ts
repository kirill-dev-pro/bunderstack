import nodemailer from 'nodemailer'

import type { EmailAdapter } from '../email'
import type { EmailMessage, SentEmail } from '../email'
import type { MessagingDescriptor } from '../messaging/types'

import { descriptor } from '../messaging/types'

type SmtpTransport = {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>
}

export function createSmtpAdapter(
  options: { url: string },
  createTransport: (url: string) => SmtpTransport = (url) =>
    nodemailer.createTransport(url) as SmtpTransport,
): EmailAdapter {
  const toArray = (v: string | string[] | undefined) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v]

  let transportPromise: Promise<{
    sendMail(opts: Record<string, unknown>): Promise<{ messageId?: string }>
  }> | null = null

  const getTransport = () => {
    transportPromise ??= Promise.resolve(createTransport(options.url))
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

export const smtp = (options: {
  url: string
  from?: string
}): MessagingDescriptor<
  'email',
  'smtp',
  EmailMessage,
  SentEmail,
  { adapter: EmailAdapter; from?: string }
> =>
  descriptor('email', 'smtp', {
    adapter: createSmtpAdapter(options),
    from: options.from,
  })
