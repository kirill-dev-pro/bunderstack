import { descriptor, type MessagingDescriptor } from './types'

export type TelegramMessage = {
  to: string | number
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
}

export type SentTelegramMessage = {
  id?: string
  providerId?: string
}

export type TelegramConfig = { botToken?: string }

export type TelegramDescriptor = MessagingDescriptor<
  'telegram',
  'telegram',
  TelegramMessage,
  SentTelegramMessage,
  TelegramConfig
>

export function telegram(config: TelegramConfig = {}): TelegramDescriptor {
  return descriptor('telegram', 'telegram', config)
}
