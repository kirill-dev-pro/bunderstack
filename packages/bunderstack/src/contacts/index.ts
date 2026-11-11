import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  like,
  or,
  sql,
} from 'drizzle-orm'

import type { AnyDb } from '../dialect'

import { contactTablesFor } from '../internal-tables'

/** The ways a contact can be reached. Only email is sent to today. */
export type ContactAddressKind = 'email'

export type ContactAddress = {
  id: string
  kind: ContactAddressKind
  address: string
  /** When the person agreed to hear from you; optional, never required. */
  consentedAt: number | null
  consentSource: string | null
  /** Set by the unsubscribe link, the API or the dashboard. Always honoured. */
  unsubscribedAt: number | null
  /** A hard bounce or a complaint; the address is not written to again. */
  suppressedAt: number | null
  suppressedReason: string | null
}

export type Contact = {
  id: string
  name: string | null
  userId: string | null
  source: string | null
  attributes: Record<string, unknown>
  tags: string[]
  addresses: ContactAddress[]
  createdAt: number
  updatedAt: number
}

export type ContactInput = {
  email: string
  name?: string
  /** Where the contact came from: `waitlist`, `landing`, `import`, … */
  source?: string
  tags?: string[]
  /** Merged into what the contact already has. */
  attributes?: Record<string, unknown>
  /** The signed-up user this contact is, when it is one. */
  userId?: string
  /** Record consent. An existing consent is kept. */
  consent?: { source?: string; at?: number }
}

export type ContactSelector = { id: string } | { email: string }

export type ContactListOptions = {
  tag?: string
  source?: string
  /** Matches the name or an address. */
  search?: string
  /** `subscribed`: has an email address neither unsubscribed nor suppressed. */
  status?: 'subscribed' | 'unsubscribed' | 'suppressed' | 'consented'
  limit?: number
  offset?: number
}

export type ContactsFacade = {
  /** Adds a contact, or merges into the one that has this address. */
  upsert(input: ContactInput): Promise<Contact>
  get(selector: ContactSelector): Promise<Contact | null>
  list(
    options?: ContactListOptions,
  ): Promise<{ contacts: Contact[]; total: number }>
  tag(selector: ContactSelector, tags: string[]): Promise<Contact | null>
  untag(selector: ContactSelector, tags: string[]): Promise<Contact | null>
  /** Opts an address out of everything sent to contacts. */
  unsubscribe(selector: { email: string }): Promise<boolean>
  /** Opts it back in, e.g. when the person subscribes again. */
  resubscribe(selector: { email: string }): Promise<boolean>
  /** Erases the contact with its addresses and tags. */
  remove(selector: ContactSelector): Promise<boolean>
  /**
   * The one-click unsubscribe link for an address, or null when the
   * application has no public URL (`APP_URL`).
   */
  unsubscribeUrl(selector: { email: string }): Promise<string | null>
  /**
   * Unsubscribes the address an unsubscribe link names. For an application
   * that serves its own page (`contacts.unsubscribeUrl`); null for a token
   * that was not signed by this application.
   */
  unsubscribeByToken(token: string): Promise<{ address: string } | null>
}

export const CONTACTS_CAPTURE_PATH = '/api/_bunderstack/contacts'
export const UNSUBSCRIBE_PATH = '/api/_bunderstack/unsubscribe'

export type ContactsConfig = {
  /**
   * Accept sign-ups from the application's own forms at
   * `POST /api/_bunderstack/contacts` (`email`, optional `name`), as JSON or a
   * form post. Absent: nothing is mounted.
   */
  capture?: { source?: string; tags?: string[]; consent?: boolean }
  /**
   * Your own unsubscribe page. Links then point at it with `?t=<token>`, and
   * the page calls `verifyUnsubscribeToken`. Default: the built-in page.
   */
  unsubscribeUrl?: string
}

const MAX_TAG = 64
const MAX_TAGS = 50

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  if (email.length > 254) return null
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(email)
    ? email
    : null
}

function cleanTags(tags: string[] | undefined): string[] {
  const unique = new Set<string>()
  for (const tag of tags ?? []) {
    const value = tag.trim()
    if (!value) continue
    if (value.length > MAX_TAG)
      throw new Error(
        `[bunderstack] contact tag "${value.slice(0, 20)}…" is longer than ${MAX_TAG}`,
      )
    unique.add(value)
  }
  if (unique.size > MAX_TAGS)
    throw new Error(
      `[bunderstack] a contact takes at most ${MAX_TAGS} tags at once`,
    )
  return [...unique]
}

function parseAttributes(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const encoder = new TextEncoder()

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url')
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`bunderstack-unsubscribe:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

/** `<addressId>.<signature>`: names one address and cannot be forged. */
export async function unsubscribeToken(secret: string, addressId: string) {
  return `${addressId}.${await hmac(secret, addressId)}`
}

/** The address id a token names, or null when it was not signed by us. */
export async function verifyUnsubscribeToken(
  secret: string,
  token: string,
): Promise<string | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const addressId = token.slice(0, dot)
  const expected = await hmac(secret, addressId)
  const given = token.slice(dot + 1)
  if (given.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0 ? addressId : null
}

export function createContacts(options: {
  db: AnyDb
  secret: string
  appUrl?: string
  config?: ContactsConfig
  now?: () => number
}): ContactsFacade {
  const { db } = options
  const t = contactTablesFor(db)
  const now = options.now ?? Date.now

  async function hydrate(
    rows: {
      id: string
      name: string | null
      userId: string | null
      source: string | null
      attributesJson: string
      createdAt: number
      updatedAt: number
    }[],
  ): Promise<Contact[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [addresses, tags] = await Promise.all([
      db
        .select()
        .from(t.addresses)
        .where(inArray(t.addresses.contactId, ids))
        .orderBy(asc(t.addresses.createdAt)),
      db
        .select()
        .from(t.tags)
        .where(inArray(t.tags.contactId, ids))
        .orderBy(asc(t.tags.tag)),
    ])
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      userId: row.userId,
      source: row.source,
      attributes: parseAttributes(row.attributesJson),
      tags: tags
        .filter((tag: { contactId: string }) => tag.contactId === row.id)
        .map((tag: { tag: string }) => tag.tag),
      addresses: addresses
        .filter(
          (address: { contactId: string }) => address.contactId === row.id,
        )
        .map(
          (
            address: ContactAddress & { contactId: string; createdAt: number },
          ) => ({
            id: address.id,
            kind: address.kind as ContactAddressKind,
            address: address.address,
            consentedAt: address.consentedAt ?? null,
            consentSource: address.consentSource ?? null,
            unsubscribedAt: address.unsubscribedAt ?? null,
            suppressedAt: address.suppressedAt ?? null,
            suppressedReason: address.suppressedReason ?? null,
          }),
        ),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }))
  }

  async function addressOf(email: string) {
    const address = normalizeEmail(email)
    if (!address) return undefined
    const [row] = await db
      .select()
      .from(t.addresses)
      .where(
        and(eq(t.addresses.kind, 'email'), eq(t.addresses.address, address)),
      )
      .limit(1)
    return row as (ContactAddress & { contactId: string }) | undefined
  }

  async function contactId(
    selector: ContactSelector,
  ): Promise<string | undefined> {
    if ('id' in selector) {
      const [row] = await db
        .select({ id: t.contacts.id })
        .from(t.contacts)
        .where(eq(t.contacts.id, selector.id))
        .limit(1)
      return row?.id as string | undefined
    }
    return (await addressOf(selector.email))?.contactId
  }

  async function get(selector: ContactSelector): Promise<Contact | null> {
    const id = await contactId(selector)
    if (!id) return null
    const rows = await db
      .select()
      .from(t.contacts)
      .where(eq(t.contacts.id, id))
      .limit(1)
    return (await hydrate(rows))[0] ?? null
  }

  async function addTags(id: string, tags: string[]) {
    if (tags.length === 0) return
    await db
      .insert(t.tags)
      .values(tags.map((tag) => ({ contactId: id, tag })))
      .onConflictDoNothing()
  }

  async function setUnsubscribed(email: string, value: number | null) {
    const address = await addressOf(email)
    if (!address) return false
    await db
      .update(t.addresses)
      .set({ unsubscribedAt: value })
      .where(eq(t.addresses.id, address.id))
    await db
      .update(t.contacts)
      .set({ updatedAt: now() })
      .where(eq(t.contacts.id, address.contactId))
    return true
  }

  return {
    async upsert(input) {
      const address = normalizeEmail(input.email)
      if (!address)
        throw new Error(
          `[bunderstack] "${input.email}" is not an email address`,
        )
      const tags = cleanTags(input.tags)
      const stamp = now()
      const existing = await addressOf(address)
      let id: string
      if (existing) {
        id = existing.contactId
        const [current] = await db
          .select()
          .from(t.contacts)
          .where(eq(t.contacts.id, id))
          .limit(1)
        await db
          .update(t.contacts)
          .set({
            ...(input.name?.trim() ? { name: input.name.trim() } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            ...(input.source && !current?.source
              ? { source: input.source }
              : {}),
            ...(input.attributes
              ? {
                  attributesJson: JSON.stringify({
                    ...parseAttributes(current?.attributesJson ?? '{}'),
                    ...input.attributes,
                  }),
                }
              : {}),
            updatedAt: stamp,
          })
          .where(eq(t.contacts.id, id))
        if (input.consent && existing.consentedAt == null) {
          await db
            .update(t.addresses)
            .set({
              consentedAt: input.consent.at ?? stamp,
              consentSource: input.consent.source ?? null,
            })
            .where(eq(t.addresses.id, existing.id))
        }
      } else {
        id = `contact_${crypto.randomUUID()}`
        await db.insert(t.contacts).values({
          id,
          name: input.name?.trim() || null,
          userId: input.userId ?? null,
          source: input.source ?? null,
          attributesJson: JSON.stringify(input.attributes ?? {}),
          createdAt: stamp,
          updatedAt: stamp,
        })
        try {
          await db.insert(t.addresses).values({
            id: `caddr_${crypto.randomUUID()}`,
            contactId: id,
            kind: 'email',
            address,
            consentedAt: input.consent ? (input.consent.at ?? stamp) : null,
            consentSource: input.consent?.source ?? null,
            createdAt: stamp,
          })
        } catch (error) {
          // Another request added the address first: merge into that contact.
          await db.delete(t.contacts).where(eq(t.contacts.id, id))
          if (await addressOf(address)) return this.upsert(input)
          throw error
        }
      }
      await addTags(id, tags)
      return (await get({ id }))!
    },

    get,

    async list(listOptions = {}) {
      const limit = Math.min(Math.max(listOptions.limit ?? 50, 1), 500)
      const offset = Math.max(listOptions.offset ?? 0, 0)
      const filters = []
      if (listOptions.source)
        filters.push(eq(t.contacts.source, listOptions.source))
      if (listOptions.tag) {
        filters.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(t.tags)
              .where(
                and(
                  eq(t.tags.contactId, t.contacts.id),
                  eq(t.tags.tag, listOptions.tag),
                ),
              ),
          ),
        )
      }
      if (listOptions.search?.trim()) {
        const pattern = `%${listOptions.search.trim().toLowerCase().replace(/[%_]/g, '')}%`
        filters.push(
          or(
            like(sql`lower(${t.contacts.name})`, pattern),
            exists(
              db
                .select({ one: sql`1` })
                .from(t.addresses)
                .where(
                  and(
                    eq(t.addresses.contactId, t.contacts.id),
                    like(t.addresses.address, pattern),
                  ),
                ),
            ),
          )!,
        )
      }
      if (listOptions.status) {
        const condition = {
          subscribed: and(
            sql`${t.addresses.unsubscribedAt} is null`,
            sql`${t.addresses.suppressedAt} is null`,
          ),
          unsubscribed: sql`${t.addresses.unsubscribedAt} is not null`,
          suppressed: sql`${t.addresses.suppressedAt} is not null`,
          consented: sql`${t.addresses.consentedAt} is not null`,
        }[listOptions.status]
        filters.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(t.addresses)
              .where(
                and(
                  eq(t.addresses.contactId, t.contacts.id),
                  eq(t.addresses.kind, 'email'),
                  condition,
                ),
              ),
          ),
        )
      }
      const where = filters.length > 0 ? and(...filters) : undefined
      const [rows, [total]] = await Promise.all([
        db
          .select()
          .from(t.contacts)
          .where(where)
          .orderBy(desc(t.contacts.createdAt), desc(t.contacts.id))
          .limit(limit)
          .offset(offset),
        db.select({ value: count() }).from(t.contacts).where(where),
      ])
      return { contacts: await hydrate(rows), total: Number(total?.value ?? 0) }
    },

    async tag(selector, tags) {
      const id = await contactId(selector)
      if (!id) return null
      await addTags(id, cleanTags(tags))
      await db
        .update(t.contacts)
        .set({ updatedAt: now() })
        .where(eq(t.contacts.id, id))
      return get({ id })
    },

    async untag(selector, tags) {
      const id = await contactId(selector)
      if (!id) return null
      const remove = cleanTags(tags)
      if (remove.length > 0) {
        await db
          .delete(t.tags)
          .where(and(eq(t.tags.contactId, id), inArray(t.tags.tag, remove)))
      }
      await db
        .update(t.contacts)
        .set({ updatedAt: now() })
        .where(eq(t.contacts.id, id))
      return get({ id })
    },

    unsubscribe: ({ email }) => setUnsubscribed(email, now()),
    resubscribe: ({ email }) => setUnsubscribed(email, null),

    async remove(selector) {
      const id = await contactId(selector)
      if (!id) return false
      // SQLite cascades only with foreign keys on, so children go first.
      await db.delete(t.tags).where(eq(t.tags.contactId, id))
      await db.delete(t.addresses).where(eq(t.addresses.contactId, id))
      const deleted = await db
        .delete(t.contacts)
        .where(eq(t.contacts.id, id))
        .returning({ id: t.contacts.id })
      return deleted.length > 0
    },

    async unsubscribeUrl({ email }) {
      const address = await addressOf(email)
      if (!address) return null
      const base =
        options.config?.unsubscribeUrl ??
        (options.appUrl
          ? new URL(UNSUBSCRIBE_PATH, options.appUrl).toString()
          : undefined)
      if (!base) return null
      const url = new URL(base)
      url.searchParams.set(
        't',
        await unsubscribeToken(options.secret, address.id),
      )
      return url.toString()
    },

    async unsubscribeByToken(token) {
      const addressId = await verifyUnsubscribeToken(options.secret, token)
      if (!addressId) return null
      const [row] = await db
        .select()
        .from(t.addresses)
        .where(eq(t.addresses.id, addressId))
        .limit(1)
      if (!row) return null
      if (row.unsubscribedAt == null) {
        await db
          .update(t.addresses)
          .set({ unsubscribedAt: now() })
          .where(eq(t.addresses.id, addressId))
      }
      return { address: row.address as string }
    },
  }
}
