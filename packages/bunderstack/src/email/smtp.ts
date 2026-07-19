import nodemailer from 'nodemailer'

import type { EmailAdapter, EmailMessage } from '../email'

type TransportFactory = (url: string) => {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>
}

export function createSmtpAdapter(
  options: { url: string },
  createTransport: TransportFactory = (url) =>
    nodemailer.createTransport(url) as any,
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

export const smtp = (options: { url: string }): EmailAdapter =>
  createSmtpAdapter(options)
