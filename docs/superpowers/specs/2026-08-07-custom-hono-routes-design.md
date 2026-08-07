# Custom Hono routes — mounting user routes inside the app

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan

## Goal

Applications built on bunderstack regularly need a hand-written HTTP endpoint —
a webhook, an OAuth callback, a public REST route. Today there is no declaration
site for one. `app.router` exposes the raw Hono instance, so it is *possible*,
but the resulting pattern is bad in ways that matter.

The reference case is the Djin project's Telegram webhook
(`djin/src/bunderstack/index.ts`), whose own comment records the problem:

> The Telegram webhook is a hand-written Hono route, so it has to sit in front
> of the bunderstack core app rather than inside it.

That wrapper costs four concrete things:

1. **It bypasses rate limiting.** `buildHandler` wraps `checkRateLimit` around
   the inner Hono app. A route mounted outside only reaches `app.handler` via
   the `all('*')` fallthrough, so the webhook — the one endpoint an untrusted
   third party POSTs to — is the only route in the application with no rate
   limit.
2. **It discards type inference.** The file contains
   `export const { db, auth, env } = app as any` and passes `db: db as never`,
   purely to get context out of the app and into a handler.
3. **It forces manual dependency injection.** `createTelegramRouter({ db,
   botToken, botUsername, webhookSecret, enqueue })` hand-threads four things
   the framework already holds, including an `enqueue` closure that exists only
   to forward `app.jobs.enqueue`.
4. **It creates a second entry point.** `app.handler` and `apiApp.handler` both
   exist and only the latter is correct to deploy. Anything assuming
   `app.handler` — the manifest, Bunderhost, the blueprint generator — is
   pointed at the wrong one.

Give custom routes a declaration site with a typed context, mounted inside the
app, so all four disappear.

## Core decisions

1. **A `routes` option taking a builder callback**, mirroring `trpc`. The
   callback receives the context and returns a Hono app.
2. **The callback shape is load-bearing, not cosmetic.** Routes declared in a
   separate file cannot `import { app }`, because `app` is the value being
   constructed. This is the same circular-import problem `trpc` solves by
   accepting `(t) => router`, and it is the main reason the current escape hatch
   feels worse than it should.
3. **Mounted at root, registered before the built-ins.** Custom routes take
   precedence, matching what the wrapper pattern does today.
4. **Collisions are a startup error, never a silent shadow.** The returned app's
   registered paths are enumerated and checked against reserved prefixes and
   table routes.
5. **Session access is lazy.** The context exposes `getSession(request)` and
   `getUser(request)` rather than a resolved `user`.
6. **One Hono app, not keyed groups.** Users compose internally with `.route()`.
7. **Errors stay the user's.** Bunderstack installs no error handler over custom
   routes.

## Public API

```ts
import { Hono } from 'hono'

createBunderstack({
  schema,
  access,
  routes: (ctx) => {
    const r = new Hono()
    r.post('/webhooks/telegram', async (c) => {
      const raw = await c.req.text()
      if (!verify(raw, c.req.header('x-telegram-bot-api-secret-token'))) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      await ctx.jobs.enqueue('processTelegramMessage', { raw })
      return c.json({ ok: true })
    })
    return r
  },
})
```

For declarations in a separate file, the context type is exported:

```ts
import type { BunderstackRouteContext } from 'bunderstack'

export function createTelegramRoutes(
  ctx: BunderstackRouteContext<typeof schema, Env>,
): Hono { /* … */ }
```

This mirrors `BunderstackJobsBuilder`, which exists for the same reason.

## The context

Named `RouteContext` internally with `BunderstackRouteContext` exported as its
alias, matching the existing `JobContext` / `BunderstackJobContext` pair in
`jobs/define.ts`.

```ts
export type RouteContext<
  TSchema extends Record<string, unknown>,
  TEnvResult,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  /** Resolve the caller's session. Costs an auth round-trip; call only when needed. */
  getSession(
    request: Request,
  ): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>
  /** Convenience wrapper over getSession when the organization is irrelevant. */
  getUser(request: Request): Promise<AccessUser | null>
}
```

The members match the tRPC context minus the per-request `req` and `user`. The
context is built once at construction and closed over by handlers.

**Why session resolution is lazy.** The tRPC context resolves `user` eagerly
because nearly every procedure needs it. A webhook has no session at all, so
eager resolution would spend an auth round-trip on every inbound POST for a
result the handler never reads. `getSession` and `getUser` delegate to the
existing `resolveSession` / `resolveAccessUser` in `access.ts` — no new session
logic is introduced.

Routes are **public by default**. Bunderstack applies no implicit auth
requirement, because the primary use case has no session. A route that needs a
user calls `getSession` and returns 401 itself, or the application composes its
own Hono middleware over the same helper.

## Mounting and precedence

In `buildHandler`, the custom router is registered at `/` **before** every
built-in route, so Hono matches it first. `app.handler` remains the single entry
point; nothing changes for applications that do not configure `routes`.

## Startup validation

Hono exposes `app.routes` as `{ method, path, handler }[]`, and `.route(prefix,
sub)` flattens sub-app paths with the prefix applied — so the full set of
declared paths is knowable at construction time.

Reject at startup when a declared path collides with:

| Reserved | Owner |
|---|---|
| `/health`, `/api/health` | health check |
| `/api/auth/*` | BetterAuth |
| `/api/trpc/*` | tRPC |
| `/api/files/*`, `/files/*` | storage router |
| `/api/realtime` | realtime SSE |
| `/api/<tableName>`, `/api/<tableName>/*` | generated CRUD, per access-enabled table |

Additionally, reject any path whose first segment under `/api/` is a parameter
or wildcard (`/api/:x/…`, `/api/*`). Such a route shadows every table route at
once and no literal comparison would catch it.

The error names the offending path and what it collides with, for example:

```
[bunderstack] routes: "POST /api/posts" collides with the generated CRUD route
for table "posts". Choose a different path.
```

Rationale: a shadowed route fails as a silent 404 or, worse, silently
intercepts authentication. A boot-time error is the cheapest possible place to
learn about it.

## Rate limiting

Custom routes sit inside the Hono app that `checkRateLimit` wraps, so they are
rate limited automatically with no extra configuration. This closes the hole the
wrapper pattern creates today.

No per-route opt-out in this iteration. If a legitimate need appears — a webhook
sender that bursts past the global limit — it can be added later against a real
case rather than a hypothetical one.

## Request body integrity

Webhook signature verification is the primary use case, and it requires the
unmodified request body. Nothing upstream of the custom router consumes it:
`createRateLimiter` reads only `x-forwarded-for` and `x-real-ip` headers. So
`c.req.raw`, `c.req.text()`, and `c.req.arrayBuffer()` all behave normally.

This is a property worth protecting rather than assuming, so it gets an explicit
test: a route that reads the raw body must observe the exact bytes that were
sent.

## Error handling

A custom route that throws produces Hono's default 500. Bunderstack does not
install an error handler over user routes, so an application's own
`r.onError(...)` is not shadowed. Custom routes own their error semantics
entirely, which is consistent with them being raw Hono.

Validation errors from the startup collision check throw during
`createBunderstack`, alongside the other configuration errors.

## Testing

- Context carries `db`, `env`, `storage`, `email`, `jobs`, `realtime`, `auth`,
  and both session helpers, with `db` and `env` correctly typed from the config.
- A route that never calls `getSession` triggers no auth call.
- `getSession` returns the resolved user and active organization for an
  authenticated request, and nulls for an anonymous one.
- A custom route at a non-reserved path takes precedence over the fallthrough.
- A path colliding with each reserved prefix throws at startup, one case per row
  of the table above.
- A path colliding with an access-enabled table name throws at startup.
- A path with a parameter or wildcard first segment under `/api/` throws.
- A disabled table's name does **not** collide, since no CRUD route exists.
- Custom routes are rate limited.
- A route reading the raw body observes the exact bytes sent.
- An app with no `routes` configured behaves exactly as before.

## Out of scope

- **Per-route auth middleware helpers.** `getSession` is enough to build one;
  bunderstack does not ship an opinion yet.
- **Per-group rate-limit configuration.**
- **Keyed route groups.** One Hono app; compose with `.route()`.
- **OpenAPI or client generation for custom routes.** They stay outside the
  typed client surface — a custom route is an escape hatch, not part of the
  inferred contract.
- **Migrating Djin.** Its own change, once this ships.
