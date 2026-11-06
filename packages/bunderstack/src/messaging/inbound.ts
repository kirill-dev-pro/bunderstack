// src/messaging/inbound.ts — mail the host delivers to a receiving channel.
//
// Bunderhost receives the message, parses it, finds the environment by the
// recipient's domain and POSTs it here signed with the channel's secret. The
// receiver writes a journal row and enqueues the channel's `jobs.inbound`
// handler; the handler gets the parsed message. Nothing here talks to a mail
// provider, so the contract stays the same whichever provider receives.
import { and, eq } from 'drizzle-orm'
import * as v from 'valibot'

import type { AnyDb } from '../dialect'

import { messagesTableFor } from '../internal-tables'
import { reapMessageJournal } from './journal'

export const INBOUND_PATH = '/api/_bunderstack/messaging/inbound'
export const INBOUND_SIGNATURE_HEADER = 'bunderhost-signature'
/** A signature older or newer than this is a replay, not a delivery. */
export const INBOUND_TOLERANCE_SECONDS = 300
/** Text and HTML arrive capped at 1 MB each; the rest is headers. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export type InboundAddress = { address: string; name?: string }

export type InboundAttachment = {
  filename: string | null
  contentType: string
  size: number
  contentId: string | null
}

/**
 * Receipt checks from the receiving provider: `PASS`, `FAIL`, `GRAY`,
 * `PROCESSING_FAILED` or `DISABLED` for SES.
 */
export type InboundVerdicts = {
  spf: string
  dkim: string
  dmarc: string
  spam: string
  virus: string
}

export type InboundEmail = {
  /** Journal row id. */
  id: string
  /** The receiving provider's id for the message. */
  providerId: string
  channel: string
  receivedAt: Date
  /** SMTP envelope: who handed the message over and which of our addresses it was for. */
  envelope: { from: string; to: string[] }
  verdicts: InboundVerdicts
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  date: Date | null
  subject: string
  from: InboundAddress | null
  to: InboundAddress[]
  cc: InboundAddress[]
  replyTo: InboundAddress[]
  text: string | null
  html: string | null
  /** True when `text` or `html` was cut to fit; `raw()` has the whole message. */
  truncated: boolean
  headers: { name: string; value: string }[]
  attachments: InboundAttachment[]
  /** Size of the original message in bytes. */
  size: number
  /** First value of a header, compared case-insensitively. */
  header(name: string): string | undefined
  /**
   * The original MIME message. The host's link to it expires seven days after
   * the message arrived.
   */
  raw(): Promise<Uint8Array>
}

const address = v.object({
  address: v.string(),
  name: v.optional(v.string()),
})

export const inboundPayloadSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  channel: v.pipe(v.string(), v.minLength(1)),
  environmentId: v.optional(v.string()),
  receivedAt: v.string(),
  envelope: v.object({ from: v.string(), to: v.array(v.string()) }),
  verdicts: v.object({
    spf: v.string(),
    dkim: v.string(),
    dmarc: v.string(),
    spam: v.string(),
    virus: v.string(),
  }),
  message: v.object({
    messageId: v.nullish(v.string()),
    inReplyTo: v.nullish(v.string()),
    references: v.optional(v.array(v.string()), []),
    date: v.nullish(v.string()),
    subject: v.optional(v.string(), ''),
    from: v.nullish(address),
    to: v.optional(v.array(address), []),
    cc: v.optional(v.array(address), []),
    replyTo: v.optional(v.array(address), []),
    text: v.nullish(v.string()),
    html: v.nullish(v.string()),
    truncated: v.optional(v.boolean(), false),
    headers: v.optional(
      v.array(v.object({ name: v.string(), value: v.string() })),
      [],
    ),
    attachments: v.optional(
      v.array(
        v.object({
          filename: v.nullish(v.string()),
          contentType: v.string(),
          size: v.number(),
          contentId: v.nullish(v.string()),
        }),
      ),
      [],
    ),
  }),
  raw: v.object({ url: v.string(), size: v.number() }),
})

export type InboundPayload = v.InferInput<typeof inboundPayloadSchema>
type ParsedPayload = v.InferOutput<typeof inboundPayloadSchema>

const encoder = new TextEncoder()

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(message),
  )
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function equalText(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/**
 * The `Bunderhost-Signature` value for a delivery: `t=<unix seconds>,v1=<hex
 * HMAC-SHA256 of "<t>.<body>">`. The host signs with it; tests use it too.
 */
export async function signInboundPayload(
  secret: string,
  body: string,
  now: number = Date.now(),
): Promise<string> {
  const timestamp = Math.floor(now / 1000)
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

export async function verifyInboundSignature(
  header: string | null,
  body: string,
  secrets: readonly string[],
  now: number = Date.now(),
): Promise<boolean> {
  if (!header) return false
  const parts = new Map(
    header.split(',').map((part) => {
      const [key = '', ...rest] = part.trim().split('=')
      return [key, rest.join('=')] as const
    }),
  )
  const timestamp = Number(parts.get('t'))
  const signature = parts.get('v1')
  if (!Number.isInteger(timestamp) || !signature) return false
  if (Math.abs(now / 1000 - timestamp) > INBOUND_TOLERANCE_SECONDS) return false
  for (const secret of secrets) {
    if (equalText(await hmacHex(secret, `${timestamp}.${body}`), signature)) {
      return true
    }
  }
  return false
}

/** A receiving channel as the runtime resolved it. */
export type InboundRoute = {
  channel: string
  provider: string
  /** Absent until the host configures receiving for the channel. */
  secret: string | undefined
  domains: readonly string[]
  /** The `jobs.inbound` job that handles the channel. */
  job: string
}

export type InboundReceiverOptions = {
  db: AnyDb | undefined
  routes: readonly InboundRoute[]
  enqueue(
    name: string,
    input: { messageId: string },
    opts: { dedupeKey: string },
  ): Promise<unknown>
  now?: () => number
}

export type InboundReceiver = {
  /** The HTTP endpoint the host delivers to. */
  handle(request: Request): Promise<Response>
  /** Accept an already-verified delivery (tests, and the endpoint itself). */
  accept(payload: unknown): Promise<{ id: string; duplicate: boolean }>
}

export class InboundRejected extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export function createInboundReceiver(
  options: InboundReceiverOptions,
): InboundReceiver {
  const now = options.now ?? Date.now
  const routes = new Map(options.routes.map((route) => [route.channel, route]))

  const accept = async (raw: unknown) => {
    const result = v.safeParse(inboundPayloadSchema, raw)
    if (!result.success) {
      throw new InboundRejected(
        422,
        `invalid delivery: ${v.summarize(result.issues)}`,
      )
    }
    const payload = result.output
    const route = routes.get(payload.channel)
    if (!route) {
      throw new InboundRejected(
        422,
        `channel "${payload.channel}" does not receive mail`,
      )
    }
    const db = options.db
    if (!db) {
      throw new InboundRejected(503, 'no database to journal the message')
    }
    const table = messagesTableFor(db)
    const id = `message_${crypto.randomUUID()}`
    const stamp = now()
    // `receiving` until the handler job is enqueued, `received` after: a
    // repeated delivery of a `received` message is a no-op, a repeated
    // delivery of one that never got its job enqueues it now.
    const inserted = await db
      .insert(table)
      .values({
        id,
        channel: payload.channel,
        kind: 'email',
        provider: route.provider,
        credentialSource: 'managed',
        providerId: payload.id,
        status: 'receiving',
        recipientsJson: JSON.stringify({
          from: payload.envelope.from,
          to: payload.envelope.to,
        }),
        contentJson: JSON.stringify(payload),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoNothing()
      .returning({ id: table.id })
    if (inserted[0]) await reapMessageJournal(db)
    let rowId = inserted[0]?.id as string | undefined
    if (!rowId) {
      const [existing] = await db
        .select({ id: table.id, status: table.status })
        .from(table)
        .where(
          and(
            eq(table.provider, route.provider),
            eq(table.providerId, payload.id),
          ),
        )
        .limit(1)
      if (!existing) throw new InboundRejected(500, 'journal write was lost')
      if (existing.status !== 'receiving') {
        return { id: String(existing.id), duplicate: true }
      }
      rowId = String(existing.id)
    }
    await options.enqueue(
      route.job,
      { messageId: rowId },
      { dedupeKey: `inbound:${rowId}` },
    )
    await db
      .update(table)
      .set({ status: 'received', updatedAt: now() })
      .where(and(eq(table.id, rowId), eq(table.status, 'receiving')))
    return { id: rowId, duplicate: false }
  }

  const secrets = [
    ...new Set(
      options.routes
        .map((route) => route.secret)
        .filter((secret): secret is string => Boolean(secret)),
    ),
  ]

  return {
    accept,
    async handle(request) {
      if (request.method !== 'POST') {
        return json(405, { error: 'method not allowed' })
      }
      const length = Number(request.headers.get('content-length') ?? 0)
      if (length > MAX_BODY_BYTES) {
        return json(413, { error: 'delivery too large' })
      }
      const body = await request.text()
      if (encoder.encode(body).byteLength > MAX_BODY_BYTES) {
        return json(413, { error: 'delivery too large' })
      }
      if (
        secrets.length === 0 ||
        !(await verifyInboundSignature(
          request.headers.get(INBOUND_SIGNATURE_HEADER),
          body,
          secrets,
          now(),
        ))
      ) {
        return json(401, { error: 'invalid signature' })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return json(422, { error: 'delivery is not JSON' })
      }
      try {
        return json(200, { accepted: true, ...(await accept(parsed)) })
      } catch (error) {
        if (error instanceof InboundRejected) {
          return json(error.status, { error: error.message })
        }
        throw error
      }
    },
  }
}

const addressOf = (value: { address: string; name?: string }) =>
  value.name
    ? { address: value.address, name: value.name }
    : { address: value.address }

function inboundEmail(
  row: { id: string; providerId: string | null; channel: string },
  payload: ParsedPayload,
  fetchFn: typeof fetch,
): InboundEmail {
  const message = payload.message
  const date = message.date ? new Date(message.date) : null
  return {
    id: row.id,
    providerId: row.providerId ?? payload.id,
    channel: row.channel,
    receivedAt: new Date(payload.receivedAt),
    envelope: { from: payload.envelope.from, to: [...payload.envelope.to] },
    verdicts: { ...payload.verdicts },
    messageId: message.messageId ?? null,
    inReplyTo: message.inReplyTo ?? null,
    references: [...message.references],
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    subject: message.subject,
    from: message.from ? addressOf(message.from) : null,
    to: message.to.map(addressOf),
    cc: message.cc.map(addressOf),
    replyTo: message.replyTo.map(addressOf),
    text: message.text ?? null,
    html: message.html ?? null,
    truncated: message.truncated,
    headers: message.headers.map((header) => ({ ...header })),
    attachments: message.attachments.map((attachment) => ({
      filename: attachment.filename ?? null,
      contentType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId ?? null,
    })),
    size: payload.raw.size,
    header(name) {
      const wanted = name.toLowerCase()
      return message.headers.find(
        (header) => header.name.toLowerCase() === wanted,
      )?.value
    },
    async raw() {
      const response = await fetchFn(payload.raw.url)
      if (!response.ok) {
        throw new Error(
          `[bunderstack] the original of message ${row.id} is no longer available (${response.status})`,
        )
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/** The received message a `jobs.inbound` handler gets, or null if its row is gone. */
export async function loadInboundEmail(
  db: AnyDb,
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<InboundEmail | null> {
  const table = messagesTableFor(db)
  const [row] = await db
    .select({
      id: table.id,
      providerId: table.providerId,
      channel: table.channel,
      contentJson: table.contentJson,
    })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  if (!row) return null
  const payload = v.parse(inboundPayloadSchema, JSON.parse(row.contentJson))
  return inboundEmail(
    {
      id: String(row.id),
      providerId: row.providerId ? String(row.providerId) : null,
      channel: row.channel,
    },
    payload,
    fetchFn,
  )
}
