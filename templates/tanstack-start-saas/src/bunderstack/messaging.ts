import type { EmailDescriptor } from 'bunderstack/messaging'

import { email } from 'bunderstack'

import type { RelayEnv } from './env'

/**
 * Messaging channels. The host chooses the provider for every `email()`
 * channel (hosted mail or your own Resend account) and the sender; locally
 * they capture to the console. Declared in their own module so jobs and
 * procedures see the exact channel names.
 */
export const messaging = (env: RelayEnv): Channels => ({
  // Transactional mail: sign-in links, password resets, digests.
  email: email({ from: env.EMAIL_FROM }),
  // Newsletters and announcements. A separate channel lets the host give it
  // its own sender, e.g. news@news.your-domain, so complaints about
  // marketing never touch the domain sign-in mail comes from.
  news: email(),
  // Incoming mail. Connect a domain on the host's Messaging tab and anything
  // sent to it arrives here; `taskFromEmail` in jobs.ts turns it into a task.
  inbox: email({ receive: true }),
})

export type Channels = {
  email: EmailDescriptor
  news: EmailDescriptor
  inbox: EmailDescriptor
}
