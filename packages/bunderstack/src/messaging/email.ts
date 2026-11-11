import type { EmailAdapter, EmailMessage, SentEmail } from '../email'

import { descriptor, type MessagingDescriptor } from './types'

export type ResendConfig = {
  apiKey?: string
  from?: string
}

export type ResendDescriptor = MessagingDescriptor<
  'email',
  'resend',
  EmailMessage,
  SentEmail,
  ResendConfig
>

export function resend(config: ResendConfig = {}): ResendDescriptor {
  return descriptor('email', 'resend', config)
}

export type SesConfig = {
  from?: string
  /**
   * Accept the mail Bunderhost routes to this channel. A receiving channel
   * needs exactly one `jobs.inbound(<channel>, …)` handler.
   */
  receive?: boolean
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** SES configuration set that publishes delivery events. */
  configurationSet?: string
  /** SES tenant the message is sent through. */
  tenant?: string
}

export type SesDescriptor = MessagingDescriptor<
  'email',
  'ses',
  EmailMessage,
  SentEmail,
  SesConfig
>

/**
 * Amazon SES. On Bunderhost the credentials, region, configuration set and
 * tenant come from the platform; a channel declares only what it sends from
 * and whether it receives.
 */
export function ses(config: SesConfig = {}): SesDescriptor {
  return descriptor('email', 'ses', config)
}

export type CustomEmailConfig = {
  adapter?: EmailAdapter | EmailAdapter['send']
  from?: string
  provider?: string
}

export type CustomEmailDescriptor = MessagingDescriptor<
  'email',
  'custom',
  EmailMessage,
  SentEmail,
  CustomEmailConfig
>

export function customEmail(
  config: CustomEmailConfig = {},
): CustomEmailDescriptor {
  return descriptor('email', 'custom', config)
}

/**
 * The providers a managed `email()` channel can be routed to, in the order a
 * host offers them. A host reads this to know what an application built with
 * this version can send through.
 */
export const EMAIL_PROVIDERS = ['ses', 'resend'] as const
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number]

export type EmailConfig = {
  from?: string
  /**
   * Accept the mail the host routes to this channel. A receiving channel
   * needs exactly one `jobs.inbound(<channel>, …)` handler.
   */
  receive?: boolean
}

export type EmailDescriptor = MessagingDescriptor<
  'email',
  'managed',
  EmailMessage,
  SentEmail,
  EmailConfig
>

/**
 * An email channel whose provider the host chooses. On Bunderhost the
 * project's Messaging tab decides whether it sends through hosted SES or the
 * project's own Resend account; locally and in tests it captures. A channel
 * that must always use one provider declares it with `ses()` or `resend()`.
 */
export function email(config: EmailConfig = {}): EmailDescriptor {
  return descriptor('email', 'managed', config)
}
