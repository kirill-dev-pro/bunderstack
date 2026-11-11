import type { ContactsConfig, ContactsFacade } from './index'

import {
  CONTACTS_CAPTURE_PATH,
  normalizeEmail,
  UNSUBSCRIBE_PATH,
} from './index'

type Contacts = ContactsFacade

const CAPTURE_PER_MINUTE = 10

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}button{color:#141414;background:#eee}}h1{font-size:1.25rem}button{font:inherit;padding:.5rem 1rem;border:0;border-radius:4px;color:#fff;background:#1a1a1a;cursor:pointer}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  )
}

/** `ana@customer.example` → `a••@customer.example`: enough to recognise. */
function mask(address: string): string {
  const at = address.indexOf('@')
  return at <= 1 ? address : `${address[0]}••${address.slice(at)}`
}

function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

async function fields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => null)) as unknown
    if (!body || typeof body !== 'object') return {}
    return Object.fromEntries(
      Object.entries(body).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }
  const form = await req.formData().catch(() => null)
  if (!form) return {}
  return Object.fromEntries(
    [...form.entries()].filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/**
 * The two contact routes: sign-ups from the application's own forms, and the
 * unsubscribe link every message to a contact carries. Returns null for any
 * other path.
 */
export function createContactsHandler(
  contacts: Contacts,
  config: ContactsConfig | undefined,
): (req: Request) => Promise<Response | null> {
  const hits = new Map<string, { count: number; resetAt: number }>()

  function limited(req: Request): boolean {
    const now = Date.now()
    const key = clientIp(req)
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      if (hits.size > 10_000) hits.clear()
      hits.set(key, { count: 1, resetAt: now + 60_000 })
      return false
    }
    entry.count += 1
    return entry.count > CAPTURE_PER_MINUTE
  }

  async function capture(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      })
    }
    if (limited(req)) return new Response('Too Many Requests', { status: 429 })
    const body = await fields(req)
    const redirect =
      body.redirect?.startsWith('/') && !body.redirect.startsWith('//')
        ? body.redirect
        : undefined
    const done = () =>
      redirect
        ? new Response(null, { status: 303, headers: { Location: redirect } })
        : new Response(null, { status: 204 })
    // A filled honeypot is a bot. It gets the same answer as a person.
    if (body.website || body.company_website) return done()
    const email = normalizeEmail(body.email ?? '')
    if (!email) {
      return Response.json(
        { error: 'email is not an email address' },
        { status: 400 },
      )
    }
    const capture = config?.capture
    await contacts.upsert({
      email,
      ...(body.name?.trim() ? { name: body.name.trim().slice(0, 200) } : {}),
      ...(capture?.source ? { source: capture.source } : {}),
      ...(capture?.tags ? { tags: capture.tags } : {}),
      ...(capture?.consent
        ? { consent: { source: capture.source ?? 'form' } }
        : {}),
    })
    // Always the same answer, so the form cannot tell whether an address is known.
    return done()
  }

  async function unsubscribe(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const token = url.searchParams.get('t') ?? ''
    if (req.method === 'GET') {
      // Mail scanners open links; only a POST unsubscribes.
      const action = `${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`
      return page(
        'Unsubscribe',
        `<h1>Unsubscribe</h1><p>Stop receiving these emails?</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
      )
    }
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, POST' },
      })
    }
    const result = await contacts.unsubscribeByToken(token)
    if (!result) {
      return page(
        'Link not valid',
        '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>',
        400,
      )
    }
    return page(
      'Unsubscribed',
      `<h1>You are unsubscribed</h1><p>${escapeHtml(mask(result.address))} will not receive these emails any more.</p>`,
    )
  }

  return async (req) => {
    const pathname = new URL(req.url).pathname
    if (pathname === UNSUBSCRIBE_PATH) return unsubscribe(req)
    if (pathname === CONTACTS_CAPTURE_PATH && config?.capture)
      return capture(req)
    return null
  }
}
