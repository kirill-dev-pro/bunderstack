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

/** Adapters receive the message with `from` already resolved. */
export type EmailAdapter = {
  send(msg: EmailMessage & { from: string }): Promise<{ id?: string }>
}

export type EmailFacade = {
  send(msg: EmailMessage): Promise<SentEmail>
}
