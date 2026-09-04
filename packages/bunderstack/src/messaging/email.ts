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
