# Env validation, tRPC endpoints, and email sending

Date: 2026-07-12
Branch: main (feature branch to be created at implementation time)
Packages: `packages/bunderstack`, `packages/bunderstack-query`

## Context

Bunderstack currently composes db (Drizzle), REST CRUD, auth (better-auth),
storage, and realtime behind a single config object. Three gaps remain for a
batteries-included backend:

1. **Env validation** — config values are sourced ad-hoc
   (`process.env.DATABASE_URL ?? 'file:./data.db'` scattered through
   `src/config.ts`), with no validation, no fail-fast, and no way for users to
   declare their own required vars.
2. **Custom endpoints** — there is no blessed way to add non-CRUD endpoints.
   The motivating case: a twitter-style feed endpoint that returns posts +
   likes + users in one call instead of three client round-trips.
3. **Email** — no email capability, and better-auth's verification /
   password-reset flows require hand-wiring `sendVerificationEmail` /
   `sendResetPassword`.

All three are defined from the bunderstack config, consistent with the
existing surface. Decisions validated in brainstorming:

- Endpoints: adopt **tRPC** as the endpoint layer (compose best-in-class,
  don't invent a parallel RPC), defined inline in the config via a builder
  callback, picked up by `bunderstack-query` through the `$inferClient`
  phantom using tRPC's official TanStack Query integration.
- Env: built-in base schema inside the lib + user extension in config
  (not a separate `defineEnv()` entry file); t3-env-style server/client split,
  rolled on zod (already a dependency), no `@t3-oss/env-core` dep.
- Email: built-in adapters (`resend` first-class, `smtp`, `console`) plus a
  custom-adapter escape hatch; auto-wire better-auth email flows. More
  built-in adapters can be added later behind the same interface.
- Endpoint payloads use superjson (tRPC's transformer slot) so Dates, Maps,
  Sets, BigInt, and `undefined` survive the round trip.

## Goals

- `createBunderstack()` refuses to boot with a single aggregated error when
  env is missing/invalid; validated typed env exposed as `app.env`.
- Users declare typed tRPC procedures inline in the config; the query-library
  client calls them fully typed with TanStack Query integration.
- `app.email.send()` works with one line of config; better-auth email flows
  work automatically once email is configured.

## Non-goals

- No email templating system (plain default templates for auth mails only).
- No additional email adapters beyond resend/smtp/console in this iteration.
- No tRPC subscriptions/WebSocket link in this iteration (bunderstack's SSE
  realtime remains the realtime story).

---

## 1. Env validation

New module `packages/bunderstack/src/env.ts`, plus a browser-safe subpath
export `bunderstack/env`.

### Built-in base schema

Always validated inside `createBunderstack()`, even when the user passes no
`env` key:

| Var | Rule |
|---|---|
| `DATABASE_URL` | optional, default `file:./data.db` |
| `DATABASE_AUTH_TOKEN` | optional |
| `AUTH_SECRET` | required when `NODE_ENV=production`; dev default otherwise |
| `REDIS_URL` | optional |
| `RESEND_API_KEY` | required only when email provider is `'resend'` |
| `SMTP_URL` | required only when email provider is `'smtp'` |

### User extension

```ts
createBunderstack({
  schema,
  env: {
    server: { OPENAI_API_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string().url() },
    // optional, for bundlers that don't expose process.env (Vite):
    runtimeEnv: { PUBLIC_APP_URL: import.meta.env.PUBLIC_APP_URL, ... },
  },
})
```

- `client` keys MUST start with `PUBLIC_` (validated at boot; boot error
  otherwise). `server` keys MUST NOT start with `PUBLIC_`.
- Validation aggregates **all** failures into one thrown error listing every
  missing/invalid var, then refuses to boot.
- The merged, typed result (base + user server + user client) is exposed as
  `app.env` and as `ctx.env` in tRPC procedures.
- `resolveConfig()` consumes the validated env instead of raw `process.env`
  reads — single source of truth. Explicit config fields
  (`database: { url }`) still win over env, unchanged precedence.

### Browser side

t3-env's client pattern, adapted: the `env` config object may live in a
shared file. `bunderstack/env` (no server imports, safe for client bundles)
exports `createClientEnv(envConfig)`:

- Validates only the `client` section.
- Returns an object where accessing a server key throws
  (`"AUTH_SECRET is server-only"`).
- Values resolve from `runtimeEnv` if provided, else `process.env.PUBLIC_*`
  (inlined by the bundler; Bun: `bun build --env 'PUBLIC_*'`, Vite: pass
  `import.meta.env` values via `runtimeEnv`).

### Type plumbing

`BunderstackConfig` gains a `TEnv` generic inferred from the `env` key.
`app.env` is typed as `BaseEnv & InferServerEnv<TEnv> & InferClientEnv<TEnv>`.

## 2. tRPC endpoints

Adopt tRPC (v11) as the custom-endpoint layer instead of inventing a parallel
RPC format. New module `packages/bunderstack/src/trpc.ts`; tRPC's fetch
adapter mounted at `/api/trpc/*` in `src/handler.ts`.

New dependencies: `@trpc/server` (bunderstack), `@trpc/client` +
`@trpc/tanstack-query` (bunderstack-query), `superjson` (both). All are
zero-transitive-dependency packages.

### Definition — builder callback in config

The `trpc` config key is a function receiving a pre-built `t` instance, so
the full app stays definable as one config object with no separate
`initTRPC`/`createTRPC` invocation:

```ts
const app = createBunderstack({
  schema,
  env: { server: { OPENAI_API_KEY: z.string() } },
  email: { from: 'hello@myapp.com', provider: 'resend' },
  trpc: (t) =>
    t.router({
      feed: t.procedure
        .input(z.object({ cursor: z.string().optional() }))
        .query(async ({ ctx, input }) => {
          // one query joining posts + likes + users
          return { posts, nextCursor }   // Date columns fine — superjson
        }),
      sendReport: t.protectedProcedure   // UNAUTHORIZED without session
        .input(z.object({ postId: z.string() }))
        .mutation(async ({ ctx, input }) => { /* ... */ }),
    }),
})
```

- `TSchema`/`TEnv` are inferred from the sibling config keys; the callback's
  `t` parameter is typed contextually from them (same pattern as drizzle's
  `relations()` callback); the router type is inferred from the callback's
  return value and lands on `$inferClient`.
- The `t` instance bunderstack builds provides:
  - `t.router`, `t.middleware`, `t.mergeRouters` — plain tRPC, nothing
    wrapped. Nested routers compose inline: `t.router({ posts: t.router({...}) })`.
  - `t.procedure` — base procedure; `ctx` is
    `{ db, user, env, email, req }` with `user: AccessUser | null`
    (resolved via the existing `AuthSessionResolver`), `db` the user-schema
    drizzle instance, `req` the raw `Request`.
  - `t.protectedProcedure` — pre-built auth middleware: throws tRPC
    `UNAUTHORIZED` without a session; narrows `ctx.user` to non-null.
- superjson is configured as the transformer on the instance — Dates, Maps,
  Sets, BigInt, `undefined` round-trip in inputs and outputs; procedures can
  return drizzle rows with `Date` columns directly. (CRUD routes keep their
  existing plain-JSON wire format.)

### Escape hatch

`trpc:` also accepts a pre-built router (not just a callback), and
`bunderstack/trpc` exports `createTRPC<typeof schema>()` returning the same
`t` instance — for apps that outgrow the inline callback and want procedures
split across files/routers. The callback is the blessed inline path; nothing
seals.

### Mounting and errors

- tRPC's `fetchRequestHandler` mounted at `/api/trpc/*`, after
  storage/realtime routes; the existing global rate limiter already wraps it.
- Per-request context built by bunderstack from its internals (db, auth
  resolver, validated env, email facade).
- Error semantics are tRPC's own (`TRPCError` codes → HTTP statuses; zod
  input failures → `BAD_REQUEST` with issues). No bunderstack-specific error
  envelope for tRPC routes.

### Client (`bunderstack-query`)

- `$inferClient` gains a `trpc` field carrying the router type.
- `createClient<App>()` exposes a reserved `trpc` namespace built on tRPC
  v11's official `@trpc/tanstack-query` integration
  (`createTRPCOptionsProxy`), which produces the same
  `queryOptions`/`mutationOptions` shape the rest of bunderstack-query
  already uses:

```ts
api.trpc.feed.queryOptions({ cursor })       // useQuery
api.trpc.sendReport.mutationOptions()        // useMutation
```

- The underlying tRPC client uses `httpBatchLink` pointed at
  `<baseUrl>/trpc` with the superjson transformer, honoring the
  `fetch`/`baseUrl` options `createClient` already takes.

## 3. Email

New module `packages/bunderstack/src/email.ts`.

### Config

```ts
email: {
  from: 'Bunderstack <hello@myapp.com>',   // required
  provider: 'resend',                       // 'resend' | 'smtp' | 'console'
                                            // | EmailAdapter | (msg) => Promise<{ id?: string }>
}
```

### Message and adapter

- `EmailMessage`: `{ to: string | string[], subject: string, html?: string,
  text?: string, from?: string, replyTo?: string, cc?: string | string[],
  bcc?: string | string[] }`. At least one of `html`/`text` required
  (runtime error). `from` defaults from config.
- `EmailAdapter`: `{ send(msg: EmailMessage & { from: string }): Promise<{
  id?: string }> }` — adapters receive the message with `from` already
  resolved. A custom provider is this object or a bare function — the escape
  hatch, and the contract future built-in adapters implement.

### Providers

- `resend`: plain `fetch` to `https://api.resend.com/emails` — no SDK dep.
  Reads `RESEND_API_KEY` from validated env.
- `smtp`: `nodemailer` as an **optional peer dependency** (Bun has no
  built-in SMTP client); reads `SMTP_URL`. Missing nodemailer with
  `provider: 'smtp'` → clear boot error naming the install command.
- `console`: pretty-prints the message to the terminal. **Default when no
  provider is set and `NODE_ENV !== 'production'`.** In production, email
  configured without a provider → boot error.

### Surface

- `app.email.send(msg)` and `ctx.email` in tRPC procedures.
- The surface always exists: when `email` is not configured, `send()` throws
  `"email is not configured — add an email key to your bunderstack config"`
  so procedure code needs no null checks.

### better-auth auto-wiring

When `email` is configured, bunderstack injects into the better-auth options:

- `emailAndPassword.sendResetPassword`
- `emailVerification.sendVerificationEmail`

with minimal plain-text default templates (app-name + link). User-supplied
handlers in the `auth:` config always win; injection only fills gaps.

## 4. Cross-cutting

### Boot order in `createBunderstack()`

1. Validate env (base + user extension) → throw aggregated error on failure.
2. Resolve config, consuming validated env.
3. Create email facade.
4. Create db, auth (with email auto-wiring), storage, realtime — unchanged.
5. Build the `t` instance, invoke the `trpc` builder callback (or take the
   pre-built router), mount the fetch adapter.
6. Mount in handler after storage/realtime routes.

### Implementation order

1. **Env** (email depends on it for provider credentials).
2. **Email** (tRPC ctx wants it; auth wiring lands here).
3. **tRPC** server-side, then **client** support in `bunderstack-query`.

Each phase lands with tests green and is independently shippable.

### Testing (`bun test`)

- `src/env.test.ts`: base schema defaults; prod-required `AUTH_SECRET`;
  user extension merge; aggregated multi-error report; `PUBLIC_` prefix
  enforcement both directions; `createClientEnv` server-key-throws.
- `src/email.test.ts`: provider resolution (explicit, console default in
  dev, boot error in prod); message validation; resend adapter with mocked
  fetch; custom adapter passthrough; better-auth injection (fills gaps,
  never overrides user handlers).
- `src/trpc.test.ts`: builder callback receives working `t`; query/mutation
  over the mounted adapter; protectedProcedure UNAUTHORIZED without session
  and narrowed ctx.user with one; ctx contents (db/user/env/email/req);
  pre-built-router escape hatch; superjson round-trip of Date/Map/undefined
  through input and output.
- `bunderstack-query`: `trpc` namespace — queryOptions/mutationOptions
  shapes from `createTRPCOptionsProxy`, link URL construction, type-level
  test that inferred input/output match server procedures.
- Existing suites must stay green relative to the known pre-existing-failure
  baseline (3 bunderstack tests).

### Docs / examples

- The twitter-style feed procedure becomes the showcase example (posts +
  likes + users in one call).
- README/website snippets for all three features.
