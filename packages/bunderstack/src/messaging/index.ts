export { resend, ses, customEmail } from './email'
export { createMessaging } from './standalone'
export type { MessagingContext } from './standalone'
export type {
  CustomEmailConfig,
  CustomEmailDescriptor,
  ResendConfig,
  ResendDescriptor,
  SesConfig,
  SesDescriptor,
} from './email'
export {
  INBOUND_PATH,
  INBOUND_SIGNATURE_HEADER,
  signInboundPayload,
  verifyInboundSignature,
} from './inbound'
export type {
  InboundAddress,
  InboundAttachment,
  InboundEmail,
  InboundPayload,
  InboundVerdicts,
} from './inbound'
export { telegram } from './telegram'
export type {
  SentTelegramMessage,
  TelegramConfig,
  TelegramDescriptor,
  TelegramMessage,
} from './telegram'
export type {
  AnyMessagingDescriptor,
  EmailReceiving,
  MessagingConfig,
  MessagingDescriptor,
  MessagingFacade,
  MessagingFacades,
  MessagingFacadesFor,
} from './types'
