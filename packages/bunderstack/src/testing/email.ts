import type { EmailAdapter, EmailMessage } from '../email'

export type CapturedEmail = Omit<EmailMessage, 'to' | 'cc' | 'bcc'> & {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
}

export type TestEmail = {
  readonly sent: readonly Readonly<CapturedEmail>[]
}

const addresses = (value: string | string[] | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? [...value] : [value]

export function createTestEmail(): {
  adapter: EmailAdapter
  email: TestEmail
} {
  const messages: CapturedEmail[] = []
  return {
    adapter: {
      async send(message) {
        messages.push({
          ...message,
          to: addresses(message.to) ?? [],
          cc: addresses(message.cc),
          bcc: addresses(message.bcc),
        })
        return { id: `test-email-${messages.length}` }
      },
    },
    email: {
      get sent() {
        return Object.freeze(
          messages.map((message) =>
            Object.freeze({
              ...message,
              to: Object.freeze([...message.to]) as unknown as string[],
              cc: message.cc
                ? (Object.freeze([...message.cc]) as unknown as string[])
                : undefined,
              bcc: message.bcc
                ? (Object.freeze([...message.bcc]) as unknown as string[])
                : undefined,
            }),
          ),
        )
      },
    },
  }
}
