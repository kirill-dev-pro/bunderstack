import { expectTypeOf, test } from 'bun:test'

import type { EmailMessage } from '../email'
import type { TelegramMessage } from './telegram'
import type { MessagingFacades } from './types'

import { resend } from './email'
import { telegram } from './telegram'

test('messaging registry preserves provider-specific inputs', () => {
  const config = {
    email: resend({ apiKey: 'key', from: 'App <app@test.dev>' }),
    telegram: telegram({ botToken: 'token' }),
  }
  type Facades = MessagingFacades<typeof config>
  expectTypeOf<
    Parameters<Facades['email']['send']>[0]
  >().toEqualTypeOf<EmailMessage>()
  expectTypeOf<
    Parameters<Facades['telegram']['send']>[0]
  >().toEqualTypeOf<TelegramMessage>()
})
