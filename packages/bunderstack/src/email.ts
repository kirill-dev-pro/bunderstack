export type EmailMessage = {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
  /**
   * Extra headers, such as `In-Reply-To` and `References` for a reply in a
   * thread. Headers that have their own field (`From`, `To`, `Cc`, `Bcc`,
   * `Subject`, `Reply-To`) are rejected.
   */
  headers?: Record<string, string>
}

export type SentEmail = {
  id?: string
  providerId?: string
  /**
   * The `Message-ID` header of the sent message, when the provider makes it
   * knowable (SES does). Store it to match replies to the thread.
   */
  messageId?: string
}

/** Adapters receive the message with `from` already resolved. */
export type EmailAdapter = {
  send(
    msg: EmailMessage & { from: string },
  ): Promise<{ id?: string; messageId?: string }>
}

export type EmailFacade = {
  send(msg: EmailMessage): Promise<SentEmail>
}
