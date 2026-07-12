# Env validation, custom typed endpoints, and email sending

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

- Endpoints: typed RPC (option B) with a query/mutation distinction, picked up
  by `bunderstack-query` through the `$inferClient` phantom.
- Env: built-in base schema inside the lib + user extension in config
  (not a separate `defineEnv()` entry file); t3-env-style server/client split,
  rolled on zod (already a dependency), no `@t3-oss/env-core` dep.
- Email: built-in adapters (`resend` first-class, `smtp`, `console`) plus a
  custom-adapter escape hatch; auto-wire better-auth email flows. More
  built-in adapters can be added later behind the same interface.

## Goals

- `createBunderstack()` refuses to boot with a single aggregated error when
  env is missing/invalid; validated typed env exposed as `app.env`.
- Users declare typed query/mutation endpoints in config; the query-library
  client calls them fully typed with TanStack Query integration.
- `app.email.send()` works with one line of config; better-auth email flows
  work automatically once email is configured.

## Non-goals

- No superjson / rich serialization for endpoint payloads (JSON only,
  documented).
- No email templating system (plain default templates for auth mails only).
- No additional email adapters beyond resend/smtp/console in this iteration.
- No middleware/plugin system for endpoints (auth gate + input validation
  only).

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
  `app.env` and as `ctx.env` in endpoint handlers.
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

## 2. Custom typed endpoints

New module `packages/bunderstack/src/endpoints.ts`; router mounted at
`/api/endpoints/<name>` in `src/handler.ts`.

### Definition

A `defineEndpoints` helper bound to schema (and optionally env config) so
`ctx.db` / `ctx.env` are typed without generic-inference gymnastics inside
the config literal:

```ts
const endpoints = defineEndpoints({ schema, env: envConfig }, {
  feed: {
    type: 'query',                       // GET, cacheable
    input: z.object({ cursor: z.string().optional() }),
    handler: async ({ input, db, user, env, email, req }) => {
      // one query joining posts + likes + users
      return { posts, nextCursor }       // return type inferred
    },
  },
  sendReport: {
    type: 'mutation',                    // POST
    auth: true,                          // 401 before handler if no session
    input: z.object({ postId: z.string() }),
    handler: async ({ input, user, email }) => { /* ... */ },
  },
})

createBunderstack({ schema, endpoints, ... })
```

- `type: 'query' | 'mutation'` is required.
- `input` is an optional zod schema; when absent the endpoint takes no input.
- `auth?: boolean` (default `false`): when `true`, respond `401` before the
  handler runs if there is no session.
- Handler context: `{ input, db, user, env, email, req }` where `user` is
  `AccessUser | null` (resolved via the existing `AuthSessionResolver`),
  `db` is the user-schema drizzle instance, `req` the raw `Request`.

### Wire format

- Query: `GET /api/endpoints/<name>?input=<url-encoded JSON>` (single-param,
  tRPC-style — zod round-trips trivially).
- Mutation: `POST /api/endpoints/<name>` with JSON body.
- Response: JSON. Output must be JSON-serializable (documented; no dates/maps
  survive — no superjson).

### Errors

- Invalid input → `400` with zod issues, existing error shape from
  `src/errors.ts`.
- `auth: true` without session → `401`.
- Handler throw → `500`, message redacted per existing error conventions.
- Endpoint names validated at boot: URL-safe identifier
  (`/^[a-zA-Z][a-zA-Z0-9_-]*$/`); boot error otherwise. No collision concern
  with tables — separate path prefix and client namespace.

### Client (`bunderstack-query`)

- `$inferClient` gains an `endpoints` field carrying the endpoint definitions
  type.
- `createClient<App>()` exposes a reserved `endpoints` namespace, built with
  the same lazy-Proxy pattern as `files`:

```ts
api.endpoints.feed.queryOptions({ cursor })   // key: ['endpoints', 'feed', input]
api.endpoints.feed.call({ cursor })           // plain typed fetch
api.endpoints.sendReport.mutationOptions()    // for useMutation
```

- Query endpoints expose `queryOptions` + `call`; mutation endpoints expose
  `mutationOptions` + `call`. Types: input from the zod schema
  (`z.input`), output `Awaited<ReturnType<handler>>`.
- Query keys derive from `['endpoints', name, input]` so caching /
  invalidation / refetching work with TanStack Query out of the box.

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

- `app.email.send(msg)` and `ctx.email` in endpoint handlers.
- The surface always exists: when `email` is not configured, `send()` throws
  `"email is not configured — add an email key to your bunderstack config"`
  so endpoint code needs no null checks.

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
5. Build endpoint router (receives db, authResolver, env, email facade).
6. Mount in handler after storage/realtime routes.

### Implementation order

1. **Env** (email depends on it for provider credentials).
2. **Email** (endpoints ctx wants it; auth wiring lands here).
3. **Endpoints** server-side, then **client** support in `bunderstack-query`.

Each phase lands with tests green and is independently shippable.

### Testing (`bun test`)

- `src/env.test.ts`: base schema defaults; prod-required `AUTH_SECRET`;
  user extension merge; aggregated multi-error report; `PUBLIC_` prefix
  enforcement both directions; `createClientEnv` server-key-throws.
- `src/email.test.ts`: provider resolution (explicit, console default in
  dev, boot error in prod); message validation; resend adapter with mocked
  fetch; custom adapter passthrough; better-auth injection (fills gaps,
  never overrides user handlers).
- `src/endpoints.test.ts`: GET/POST wiring; `?input=` JSON parsing; zod 400s;
  auth gate 401; ctx contents (db/user/env/email/req); name validation at
  boot; JSON response shape.
- `bunderstack-query`: `endpoints` namespace — queryOptions key shape, call()
  URL construction for query vs mutation, type-level test that inferred
  input/output match server definitions.
- Existing suites must stay green relative to the known pre-existing-failure
  baseline (3 bunderstack tests).

### Docs / examples

- The twitter-style feed endpoint becomes the showcase example (posts +
  likes + users in one call).
- README/website snippets for all three features.
