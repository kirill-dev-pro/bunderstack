import { expect, test } from 'bun:test'

import { createSmtpAdapter } from './smtp'

test('smtp adapter maps EmailMessage to nodemailer', async () => {
  const calls: unknown[] = []
  const adapter = createSmtpAdapter({ url: 'smtp://localhost' }, () => ({
    async sendMail(message) {
      calls.push(message)
      return { messageId: 'mail-1' }
    },
  }))

  await expect(
    adapter.send({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 'S',
      text: 'T',
    }),
  ).resolves.toEqual({ id: 'mail-1' })
  expect(calls).toHaveLength(1)
})
