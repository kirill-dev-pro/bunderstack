import type { MessagingConfig } from '../messaging'
import type { MessagingAdapter } from '../messaging/runtime'
import type { TestEmail } from './email'

import { createTestEmail } from './email'

export type TestMessagingChannel<TInput = unknown> = {
  readonly sent: readonly Readonly<TInput>[]
}

type SendInput<T> = T extends { send(input: infer TInput): unknown }
  ? TInput
  : never

export type TestMessagingForApp<TApp> = TApp extends {
  messaging: infer TMessaging extends Record<string, unknown>
}
  ? {
      readonly [K in keyof TMessaging]: TestMessagingChannel<
        SendInput<TMessaging[K]>
      >
    }
  : Record<never, never>

export function createTestMessaging(config: MessagingConfig | undefined): {
  adapters: Record<string, MessagingAdapter>
  messaging: Record<string, TestMessagingChannel>
  authEmail: TestEmail
} {
  const adapters: Record<string, MessagingAdapter> = {}
  const messaging: Record<string, TestMessagingChannel> = {}
  let authEmail: TestEmail | undefined

  for (const [channel, descriptor] of Object.entries(config ?? {})) {
    if (descriptor.kind === 'email') {
      const capture = createTestEmail()
      adapters[channel] = capture.adapter
      messaging[channel] = capture.email
      if (channel === 'email') authEmail = capture.email
      continue
    }
    const messages: unknown[] = []
    adapters[channel] = {
      async send(input) {
        messages.push(structuredClone(input))
        return { id: `test-${channel}-${messages.length}` }
      },
    }
    messaging[channel] = {
      get sent() {
        return Object.freeze(
          messages.map((message) => Object.freeze(structuredClone(message))),
        )
      },
    }
  }

  return {
    adapters,
    messaging,
    authEmail: authEmail ?? createTestEmail().email,
  }
}
