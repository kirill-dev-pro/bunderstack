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
