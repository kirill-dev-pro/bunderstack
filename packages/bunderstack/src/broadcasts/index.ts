import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import * as v from 'valibot'

import type { ContactsConfig } from '../contacts'
import type { AnyDb } from '../dialect'
import type { QueueJobDefinition } from '../jobs/define'
import type { MessageTag } from '../messaging/ses'

import { unsubscribeLink } from '../contacts'
import { broadcastTablesFor, contactTablesFor } from '../internal-tables'
import { SEND_UNJOURNALED, type UnjournaledSender } from '../messaging/runtime'

/**
 * The worker's job that sends a broadcast. Bunderhost enqueues it (it writes
 * the row into `_bunderstack_jobs`) once a person approved the send, or with
 * `testTo` for a test send. It is not part of the manifest.
 */
export const BROADCAST_JOB_NAME = 'bunderstack:broadcast'

export type BroadcastStatus =
  | 'draft'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'cancelled'
  | 'failed'

/** Who a broadcast goes to. Unsubscribed and suppressed addresses never are. */
export type BroadcastAudience = {
  tags?: { any?: string[]; all?: string[]; none?: string[] }
  sources?: string[]
  /** `required`: only addresses with a consent record. Default `any`. */
  consent?: 'required' | 'any'
}

const DEFAULT_RATE_PER_SECOND = 5
/** One run sends for at most this long, then hands over to the next run. */
const RUN_BUDGET_MS = 4 * 60_000
const BATCH = 50
export const RECIPIENT_RETENTION_MS = 90 * 24 * 60 * 60_000
const FOLD_INTERVAL_MS = 60 * 60_000
const lastFoldAt = new WeakMap<object, number>()

const jobInput = v.strictObject({
  broadcastId: v.pipe(v.string(), v.minLength(1)),
  testTo: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.email())),
      v.minLength(1),
      v.maxLength(5),
    ),
  ),
})

export function parseAudience(json: string): BroadcastAudience {
  try {
    const value = JSON.parse(json) as BroadcastAudience
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * The SQL condition that selects a broadcast's addresses: email addresses of
 * contacts that match the audience, neither unsubscribed nor suppressed.
 * Bunderhost runs the same rules to preview a count.
 */
function audienceCondition(db: AnyDb, audience: BroadcastAudience) {
  const { contacts, addresses, tags } = contactTablesFor(db)
  const conditions = [
    eq(addresses.kind, 'email'),
    sql`${addresses.unsubscribedAt} is null`,
    sql`${addresses.suppressedAt} is null`,
  ]
  if (audience.consent === 'required') {
    conditions.push(sql`${addresses.consentedAt} is not null`)
  }
  if (audience.sources?.length) {
    conditions.push(inArray(contacts.source, audience.sources))
  }
  const hasTag = (tag: string) =>
    sql`exists (select 1 from ${tags} where ${tags.contactId} = ${contacts.id} and ${tags.tag} = ${tag})`
  if (audience.tags?.any?.length) {
    conditions.push(
      sql`(${sql.join(
        audience.tags.any.map((tag) => hasTag(tag)),
        sql` or `,
      )})`,
    )
  }
  for (const tag of audience.tags?.all ?? []) conditions.push(hasTag(tag))
  for (const tag of audience.tags?.none ?? []) {
    conditions.push(sql`not ${hasTag(tag)}`)
  }
  return and(...conditions)
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export type RenderValues = {
  name: string | null
  email: string
  attributes: Record<string, unknown>
  unsubscribeUrl: string
}

/**
 * Fills `{{name}}`, `{{email}}`, `{{attributes.<key>}}` and
 * `{{unsubscribe_url}}`. Values are escaped in HTML. A `{{name | there}}`
 * falls back to the text after the bar when the value is empty. An unknown
 * placeholder renders empty rather than leaking its braces to a reader.
 */
export function renderTemplate(
  template: string,
  values: RenderValues,
  mode: 'html' | 'text',
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g,
    (_match, key: string, fallback: string | undefined) => {
      let value: unknown
      if (key === 'name') value = values.name
      else if (key === 'email') value = values.email
      else if (key === 'unsubscribe_url') value = values.unsubscribeUrl
      else if (key.startsWith('attributes.')) {
        value = values.attributes[key.slice('attributes.'.length)]
      }
      const text =
        value === null || value === undefined || value === ''
          ? (fallback ?? '')
          : String(value)
      return mode === 'html' ? escapeHtml(text) : text
    },
  )
}

/** The message one recipient gets: personalised, with a way out. */
export function renderBroadcast(
  broadcast: { subject: string; html: string; text: string | null },
  values: RenderValues,
): {
  subject: string
  html: string
  text?: string
  headers: Record<string, string>
} {
  const mentionsLink = /\{\{\s*unsubscribe_url/.test(broadcast.html)
  let html = renderTemplate(broadcast.html, values, 'html')
  if (!mentionsLink) {
    const footer = `<p style="margin-top:32px;font-size:12px;color:#888"><a href="${escapeHtml(values.unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>`
    html = html.includes('</body>')
      ? html.replace('</body>', `${footer}</body>`)
      : `${html}${footer}`
  }
  let text = broadcast.text
    ? renderTemplate(broadcast.text, values, 'text')
    : undefined
  if (text && !/\{\{\s*unsubscribe_url/.test(broadcast.text ?? '')) {
    text = `${text}\n\nUnsubscribe: ${values.unsubscribeUrl}\n`
  }
  return {
    subject: renderTemplate(broadcast.subject, values, 'text'),
    html,
    ...(text ? { text } : {}),
    // RFC 8058 one-click unsubscribe, which Gmail and Yahoo require of bulk mail.
    headers: {
      'List-Unsubscribe': `<${values.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

/**
 * Folds recipient rows older than the retention into nothing: the broadcast
 * keeps its counters, the per-address rows go. At most once an hour per
 * database handle; a failure is logged and never fails a send.
 */
export async function foldOldRecipients(db: AnyDb, now = Date.now()) {
  if (now - (lastFoldAt.get(db) ?? 0) < FOLD_INTERVAL_MS) return
  lastFoldAt.set(db, now)
  const { recipients } = broadcastTablesFor(db)
  try {
    await db
      .delete(recipients)
      .where(lt(recipients.createdAt, now - RECIPIENT_RETENTION_MS))
  } catch (error) {
    console.warn('[bunderstack] broadcast recipient cleanup failed:', error)
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

type BroadcastJobDeps = {
  db: AnyDb
  messaging: Record<string, unknown>
  secret: string
  appUrl?: string
  contactsConfig?: ContactsConfig
  environmentId?: string
  ratePerSecond?: number
  now?: () => number
  /** Seam for tests; the real job sleeps between sends. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  runBudgetMs?: number
}

function senderFor(
  messaging: Record<string, unknown>,
  channel: string,
): UnjournaledSender {
  const facade = messaging[channel] as Partial<UnjournaledSender> | undefined
  if (!facade || typeof facade[SEND_UNJOURNALED] !== 'function') {
    throw new Error(
      `[bunderstack] broadcast channel "${channel}" is not an email channel of this application`,
    )
  }
  return facade as UnjournaledSender
}

function tagsFor(recipientId: string, environmentId?: string): MessageTag[] {
  return [
    { name: 'bunderstack_broadcast_recipient_id', value: recipientId },
    ...(environmentId
      ? [{ name: 'bunderhost_environment_id', value: environmentId }]
      : []),
  ]
}

/** Sends one run's worth of a broadcast; true when nothing is left to send. */
export async function runBroadcast(
  deps: BroadcastJobDeps,
  input: { broadcastId: string; testTo?: string[] },
  signal: AbortSignal,
): Promise<{ done: boolean }> {
  const { db } = deps
  const now = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const { broadcasts, recipients } = broadcastTablesFor(db)
  const { contacts, addresses } = contactTablesFor(db)
  const [broadcast] = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.id, input.broadcastId))
    .limit(1)
  if (!broadcast) {
    throw new Error(`[bunderstack] broadcast ${input.broadcastId} not found`)
  }
  const sender = senderFor(deps.messaging, broadcast.channel)
  const from = broadcast.fromAddress ?? undefined

  if (input.testTo) {
    // A test goes to the people checking it, as an unknown reader would see
    // it, and leaves the broadcast and its counters alone.
    for (const address of input.testTo) {
      const message = renderBroadcast(broadcast, {
        name: null,
        email: address,
        attributes: {},
        unsubscribeUrl:
          (deps.appUrl
            ? new URL('/api/_bunderstack/unsubscribe', deps.appUrl).toString()
            : 'https://example.invalid/unsubscribe') + '?test=1',
      })
      await sender[SEND_UNJOURNALED](
        {
          to: address,
          ...message,
          subject: `[Test] ${message.subject}`,
          ...(from ? { from } : {}),
        },
        [],
      )
    }
    return { done: true }
  }

  if (broadcast.status !== 'approved' && broadcast.status !== 'sending') {
    return { done: true }
  }
  if (broadcast.scheduledAt && Number(broadcast.scheduledAt) > now()) {
    return { done: true }
  }
  const probe = await unsubscribeLink(
    { secret: deps.secret, appUrl: deps.appUrl, config: deps.contactsConfig },
    'probe',
  )
  if (!probe) {
    await db
      .update(broadcasts)
      .set({
        status: 'failed',
        error:
          'APP_URL is not set, so emails could not carry an unsubscribe link',
        finishedAt: now(),
        updatedAt: now(),
      })
      .where(eq(broadcasts.id, broadcast.id))
    return { done: true }
  }

  if (broadcast.status === 'approved') {
    // Snapshot who it goes to: contacts added later do not receive it.
    const audience = parseAudience(broadcast.audienceJson)
    const rows = await db
      .select({
        contactId: contacts.id,
        addressId: addresses.id,
        address: addresses.address,
      })
      .from(addresses)
      .innerJoin(contacts, eq(contacts.id, addresses.contactId))
      .where(audienceCondition(db, audience))
    const stamp = now()
    for (let i = 0; i < rows.length; i += 200) {
      await db
        .insert(recipients)
        .values(
          rows
            .slice(i, i + 200)
            .map(
              (row: {
                contactId: string
                addressId: string
                address: string
              }) => ({
                id: `brr_${crypto.randomUUID()}`,
                broadcastId: broadcast.id,
                contactId: row.contactId,
                addressId: row.addressId,
                address: row.address,
                status: 'queued',
                createdAt: stamp,
                updatedAt: stamp,
              }),
            ),
        )
        .onConflictDoNothing()
    }
    await db
      .update(broadcasts)
      .set({
        status: 'sending',
        recipients: rows.length,
        startedAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(eq(broadcasts.id, broadcast.id), eq(broadcasts.status, 'approved')),
      )
  }

  // A row claimed by a run that died may or may not have reached the
  // provider. Sending it again could send twice, so it is reported instead.
  const interrupted = await db
    .update(recipients)
    .set({
      status: 'failed',
      error: 'interrupted before the provider answered; not sent again',
      updatedAt: now(),
    })
    .where(
      and(
        eq(recipients.broadcastId, broadcast.id),
        eq(recipients.status, 'sending'),
      ),
    )
    .returning({ id: recipients.id })
  if (interrupted.length > 0) {
    await db
      .update(broadcasts)
      .set({ failed: sql`${broadcasts.failed} + ${interrupted.length}` })
      .where(eq(broadcasts.id, broadcast.id))
  }

  const rate = Math.max(1, deps.ratePerSecond ?? DEFAULT_RATE_PER_SECOND)
  const budgetEnds = now() + (deps.runBudgetMs ?? RUN_BUDGET_MS)
  for (;;) {
    if (signal.aborted || now() >= budgetEnds) return { done: false }
    const [current] = await db
      .select({ status: broadcasts.status })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcast.id))
      .limit(1)
    if (current?.status !== 'sending') return { done: true }
    const batch = await db
      .select({
        id: recipients.id,
        address: recipients.address,
        addressId: recipients.addressId,
        name: contacts.name,
        attributesJson: contacts.attributesJson,
      })
      .from(recipients)
      .leftJoin(contacts, eq(contacts.id, recipients.contactId))
      .where(
        and(
          eq(recipients.broadcastId, broadcast.id),
          eq(recipients.status, 'queued'),
        ),
      )
      .limit(BATCH)
    if (batch.length === 0) break
    for (const row of batch) {
      if (signal.aborted || now() >= budgetEnds) return { done: false }
      const claimed = await db
        .update(recipients)
        .set({ status: 'sending', updatedAt: now() })
        .where(and(eq(recipients.id, row.id), eq(recipients.status, 'queued')))
        .returning({ id: recipients.id })
      if (claimed.length === 0) continue
      const unsubscribeUrl = (await unsubscribeLink(
        {
          secret: deps.secret,
          appUrl: deps.appUrl,
          config: deps.contactsConfig,
        },
        String(row.addressId),
        broadcast.id,
      ))!
      let attributes: Record<string, unknown> = {}
      try {
        attributes = JSON.parse(String(row.attributesJson ?? '{}'))
      } catch {}
      try {
        const message = renderBroadcast(broadcast, {
          name: (row.name as string | null) ?? null,
          email: String(row.address),
          attributes,
          unsubscribeUrl,
        })
        const result = await sender[SEND_UNJOURNALED](
          { to: String(row.address), ...message, ...(from ? { from } : {}) },
          tagsFor(String(row.id), deps.environmentId),
        )
        await db
          .update(recipients)
          .set({
            status: 'sent',
            providerId: result.providerId ?? null,
            sentAt: now(),
            updatedAt: now(),
          })
          .where(eq(recipients.id, row.id))
        await db
          .update(broadcasts)
          .set({ sent: sql`${broadcasts.sent} + 1`, updatedAt: now() })
          .where(eq(broadcasts.id, broadcast.id))
      } catch (error) {
        await db
          .update(recipients)
          .set({
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            updatedAt: now(),
          })
          .where(eq(recipients.id, row.id))
        await db
          .update(broadcasts)
          .set({ failed: sql`${broadcasts.failed} + 1`, updatedAt: now() })
          .where(eq(broadcasts.id, broadcast.id))
      }
      await wait(1000 / rate, signal)
    }
  }
  await db
    .update(broadcasts)
    .set({ status: 'sent', finishedAt: now(), updatedAt: now() })
    .where(
      and(eq(broadcasts.id, broadcast.id), eq(broadcasts.status, 'sending')),
    )
  await foldOldRecipients(db, now())
  return { done: true }
}

/** The job the runtime registers when the app runs a worker and can send email. */
export function broadcastJob(
  deps: BroadcastJobDeps,
): QueueJobDefinition<{ broadcastId: string; testTo?: string[] }> {
  return {
    kind: 'job',
    input: jobInput,
    retries: 3,
    // A broadcast is sent by one run at a time.
    concurrency: 1,
    timeout: RUN_BUDGET_MS + 60_000,
    handler: async (input, ctx) => {
      const { done } = await runBroadcast(deps, input, ctx.signal)
      if (!done) {
        // Time is up for this run: the next one carries on where it stopped.
        await ctx.jobs.enqueue(BROADCAST_JOB_NAME, {
          broadcastId: input.broadcastId,
        })
      }
    },
  }
}
