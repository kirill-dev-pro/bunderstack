export { resend, customEmail } from './email'
export { createMessaging } from './standalone'
export type { MessagingContext } from './standalone'
export type {
  CustomEmailConfig,
  CustomEmailDescriptor,
  ResendConfig,
  ResendDescriptor,
} from './email'
export { telegram } from './telegram'
export type {
  SentTelegramMessage,
  TelegramConfig,
  TelegramDescriptor,
  TelegramMessage,
} from './telegram'
export type {
  AnyMessagingDescriptor,
  MessagingConfig,
  MessagingDescriptor,
  MessagingFacade,
  MessagingFacades,
  MessagingFacadesFor,
} from './types'
