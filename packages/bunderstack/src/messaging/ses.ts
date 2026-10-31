import { AwsClient } from 'aws4fetch'

import type { EmailMessage } from '../email'
import type { MessagingAdapter } from './runtime'

export type SesCredentials = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  configurationSet?: string
  tenant?: string
}

export type MessageTag = { name: string; value: string }

const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

/**
 * SES v2 `SendEmail` with simple content, signed with SigV4. No AWS SDK: its
 * client bundles badly into application servers, and one signed POST is all
 * sending needs.
 */
export function createSesAdapter(
  credentials: SesCredentials,
  fetchFn: typeof fetch,
): MessagingAdapter {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    service: 'ses',
  })
  const endpoint = `https://email.${credentials.region}.amazonaws.com/v2/email/outbound-emails`
  return {
    async send(input: EmailMessage & { from: string; tags?: MessageTag[] }) {
      const headers = Object.entries(input.headers ?? {})
      const to = list(input.to)
      const cc = list(input.cc)
      const bcc = list(input.bcc)
      const body = {
        FromEmailAddress: input.from,
        Destination: {
          ...(to.length > 0 ? { ToAddresses: to } : {}),
          ...(cc.length > 0 ? { CcAddresses: cc } : {}),
          ...(bcc.length > 0 ? { BccAddresses: bcc } : {}),
        },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: 'UTF-8' },
            Body: {
              ...(input.html
                ? { Html: { Data: input.html, Charset: 'UTF-8' } }
                : {}),
              ...(input.text
                ? { Text: { Data: input.text, Charset: 'UTF-8' } }
                : {}),
            },
            ...(headers.length > 0
              ? {
                  Headers: headers.map(([Name, Value]) => ({ Name, Value })),
                }
              : {}),
          },
        },
        ...(input.tags && input.tags.length > 0
          ? {
              EmailTags: input.tags.map((tag) => ({
                Name: tag.name,
                Value: tag.value,
              })),
            }
          : {}),
        ...(credentials.configurationSet
          ? { ConfigurationSetName: credentials.configurationSet }
          : {}),
        ...(credentials.tenant ? { TenantName: credentials.tenant } : {}),
      }
      const request = await client.sign(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const response = await fetchFn(request)
      if (!response.ok) {
        throw new Error(
          `ses API error (${response.status}): ${await response.text()}`,
        )
      }
      const { MessageId } = (await response.json()) as { MessageId?: string }
      return {
        id: MessageId,
        // SES writes the Message-ID header from its own id and region.
        messageId: MessageId
          ? `<${MessageId}@${credentials.region}.amazonses.com>`
          : undefined,
      }
    },
  }
}
