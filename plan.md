# Bunderstack — MVP Plan

A batteries-included backend framework for TypeScript on Bun.

You give Bunderstack a Drizzle schema; it gives you auth, a realtime database API, and
file storage — wired together and typed end to end. It embeds Drizzle and
BetterAuth and re-exports their APIs, so you get the convenience of a framework
without the lock-in of a black box.

Think PocketBase's "it just works" built-ins (realtime, auth, file storage with
on-the-fly thumbnails), but as a library you compose into your own project,
mountable into TanStack Start, Next.js, or a standalone Bun server through a
single Web-Standard `Request -> Response` handler.

---

## Why this exists

PocketBase is loved because you run one thing and get a working backend with auth,
realtime, file storage, and thumbnails. Its limits: the schema lives in a SQLite
file behind an admin UI (not in your codebase), the client is loosely typed, and
the internals are sealed in Go — when you outgrow a built-in, you hit a cliff.

The Bun/TypeScript world has the opposite problem: excellent primitives (Drizzle,
BetterAuth, Hono, `Bun.s3`) but no one composing them into a coherent,
batteries-included whole. You assemble the same stack by hand on every project,
and you rebuild the same tedious built-ins (thumbnails, realtime fan-out, CRUD
routes, file validation) every time.

Bunderstack composes those primitives, ships the tedious built-ins, and — crucially —
hands the underlying pieces back to you. It is a framework that doesn't hide its
stack.

---

## Core philosophy: compose and re-export, never seal

Bunderstack's defining choice: it does **not** hide Drizzle and BetterAuth. It
configures them, connects them to one database and one config, layers realtime +
storage + thumbnails on top, and re-exports the raw instances. When you need to
drop down to plain Drizzle or configure BetterAuth directly, you can, because
they are right there.

This is the thing a sealed binary (PocketBase) structurally cannot offer, and the
reason a library beats a binary for this audience.

### Progressive disclosure — you never hit a wall

- **Level 0** — `createBunderstack({ schema })` -> working backend, zero ceremony.
- **Level 1** — pass config: auth providers, storage target, access rules.
- **Level 2** — reach into `app.db`, `app.auth`, `app.storage`, `app.router`.
- **Level 3** — bypass Bunderstack's helpers for a route; write plain Hono + Drizzle.

PocketBase gives you Level 0 and then a cliff. Bunderstack gives you Level 0 *and* the
escape hatches.

---

## The API

```ts
// bunderstack.ts — the user's setup file
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

export const app = createBunderstack({
  schema,
  auth: {
    emailPassword: true,
    providers: { github: { /* ... */ } },
  },
  storage: process.env.S3_BUCKET ? { s3: true } : { local: './uploads' },
})

// Everything is accessible, nothing is hidden:
export const { handler, db, auth, storage, realtime, router } = app
```

### The export surface

```
app.handler    (req: Request) => Promise<Response>   mount anywhere (the keystone)
app.db         raw Drizzle instance                  db.select().from(schema.posts)
app.auth       BetterAuth instance                   full BetterAuth API
app.storage    file API with thumbnails              upload / get / transform
app.realtime   broadcast + subscription              typed events
app.router     underlying Hono app                   if you want it
```

`db` is just Drizzle — full power, no wrapper. `auth` is just BetterAuth. Bunderstack's
value is that it *configured and connected* them (same DB, shared migrations, auth
tables in your schema) and added the built-ins on top.

---

## Framework portability — the architectural keystone

The single most important design decision: Bunderstack is built on the Web Standards
`Request`/`Response` interface. A Bunderstack app exposes one function —
`handler(req: Request): Promise<Response>` — and that function mounts into almost
every modern TS framework, because they all know how to call a fetch handler.

No per-framework adapters. The frameworks already speak `Request -> Response`.
This is the same mechanism that lets Hono, ElysiaJS, and the BetterAuth handler
run everywhere.

### TanStack Start — catch-all API route

```ts
// routes/api/$.ts
import { app } from '~/bunderstack'
export const ServerRoute = createServerFileRoute().methods({
  GET:  ({ request }) => app.handler(request),
  POST: ({ request }) => app.handler(request),
})
```

### Next.js (App Router) — catch-all route

```ts
// app/api/[...bunderstack]/route.ts
import { app } from '@/bunderstack'
export const GET  = (req: Request) => app.handler(req)
export const POST = (req: Request) => app.handler(req)
```

### Standalone Bun

```ts
Bun.serve({ fetch: app.handler })
```

One `handler`, every host. REST and tRPC both collapse to this same shape: tRPC's
`fetchRequestHandler` is also `Request -> Response`, so the app can expose REST
under `/api/*` and tRPC under `/trpc/*`, both served by the same `handler`.

---

## The built-ins — closing the 90% gap

These are the features that are individually annoying to build, universally
needed, and easy to get subtly wrong. They are PocketBase's quiet superpower and
Bunderstack treats them as first-class.

A feature earns "built-in" status when it is: universal need + tedious to build +
easy to get wrong. App-specific concerns (full-text search, complex authz) stay
behind the escape hatches instead.

### Image thumbnails / transforms (on the fly)

Match PocketBase's query-param transform model:

- On upload, store the original in fs / S3.
- On request, parse a transform spec (`?w=200&h=200&fit=cover&format=webp`),
  generate the variant, **cache it** (keyed by `fileId + transform-hash`), and
  serve the cache on every repeat.
- `sharp` (resize / crop / format-convert / quality) covers the whole 90%.
- The cache is what makes it production-safe: generate once, serve forever.

Roughly 150 lines, and it removes a task people genuinely hate doing themselves.

### File validation on upload

Declarative per-field/collection rules: MIME-type allowlist, size limits, image
dimension limits. Derived from schema annotations or a per-collection config.

### Auto-generated typed CRUD per table

list / get / create / update / delete with filtering, pagination, and sorting —
the boilerplate everyone rewrites. Opt-in per table, gated by access rules.

### Auth flows

BetterAuth provides the core (sessions, providers, email/password). Bunderstack wires
the tedious surrounding bits: email verification, password reset, OAuth account
linking, and an email-sending hook with a **console/no-op driver for dev** so it
works at zero config.

### Realtime (its own section below)

---

## Realtime — PocketBase's model, done honestly

PocketBase's realtime is simpler than people assume, and that simplicity is the
design we copy.

- The client opens an **SSE** (server-sent events) connection — not raw WebSocket.
- It subscribes to a table (optionally a specific record, optionally a filter).
- When a write goes **through the API**, the change is fanned out to subscribers.
- Writes that bypass the API (raw SQL, another service) do **not** fire events.

That last point is liberating: no WAL tailing, no CDC. You broadcast from your own
mutation handlers.

### Design

- Every write through Bunderstack's generated routes (or wrapped `db` helpers) calls
  `realtime.broadcast(table, action, record)`.
- Subscribers filter by table + optional record id + optional simple query filter.
- **Transport: SSE by default** — matches PocketBase, survives proxies, simple
  client, no upgrade handshake. WebSocket offered as an option for bidirectional
  needs.
- **Typed events** — the subscription callback is typed to the actual row type
  from the schema. This is where Bunderstack beats PocketBase.

### Honest caveats (document loudly)

- **Writes outside Bunderstack won't broadcast.** Same limitation PocketBase has. State
  it plainly.
- **Serverless + realtime.** SSE needs a long-lived connection; serverless hosts
  (Next.js on Vercel) don't love those. So:
  - On a **persistent runtime** (standalone Bun, TanStack Start on a Node/Bun
    host, Railway, Fly) — realtime works natively.
  - On **serverless** — REST / auth / storage work perfectly via the fetch
    handler, but realtime needs a separate persistent Bunderstack instance for the SSE
    endpoint, or an external pub/sub (Upstash, Ably, Vercel). Not a flaw — the
    same constraint everyone hits — but say so up front.
- **Multi-instance scaling** needs Redis pub/sub so a write on instance A reaches
  subscribers on instance B. Post-MVP.

---

## What Bunderstack owns vs. delegates

```
Delegated (mature libraries do the heavy lifting):
  ORM / queries / migrations   -> Drizzle + drizzle-kit
  Auth core / sessions / OAuth -> BetterAuth
  HTTP / routing / Request API -> Hono
  S3 client                    -> Bun.s3
  Image processing             -> sharp

Bunderstack owns (the value-add, deliberately small):
  Composition layer            wires the above to one DB, one config, one handler
  Built-ins                    thumbnails, file validation, CRUD generation
  Realtime layer               broadcast on write + SSE subscription + typed events
  Storage abstraction          one API over local fs and S3
  Typed client codegen         REST first, tRPC after
  Convenience CLI              bunderstack dev / db push / db migrate / generate
```

The surface Bunderstack maintains is small precisely because the hard parts are
delegated to libraries that already do them well.

---

## Configuration

Entire config surface = the `createBunderstack` options + environment variables. No
required config file.

```
# Database — default: local SQLite file (./data.db) via libSQL driver
DATABASE_URL          libsql:// (Turso/remote) or postgres:// (post-MVP)
DATABASE_AUTH_TOKEN   token for Turso / remote libSQL

# Files — default: local filesystem (./uploads/)
S3_BUCKET / S3_REGION / S3_ACCESS_KEY / S3_SECRET_KEY
S3_ENDPOINT           for R2 / MinIO / Backblaze and other S3-compatible stores

# Auth
AUTH_SECRET           required in production
```

Key simplifier: local SQLite and Turso are **both libSQL**, so Drizzle's
`drizzle-orm/libsql` driver talks to both. Dev and prod differ only by connection
string — no driver swap, no code change.

---

## Migrations — delegate, don't reinvent

Because Bunderstack is a library in a normal project, `drizzle-kit` runs as designed.
Bunderstack never owns a migration engine.

- **Dev:** `bunderstack db push` wraps `drizzle-kit push` — syncs schema -> DB directly,
  no migration files, instant loop.
- **Prod:** `bunderstack db migrate` wraps generated migration files.

This also resolves auth-table placement: BetterAuth's Drizzle adapter emits its
tables into the same Drizzle schema, so they are migrated and type-tracked
alongside user tables automatically.

---

## The generated client

A codegen step emits a typed client into the consuming project. Because the schema
is a build-time import (not runtime-loaded), generating the client runs over real
TypeScript types — a normal build step, not runtime reflection. This is what makes
the tRPC variant tractable.

```ts
// client.ts — auto-generated, commit it
import { createClient } from 'bunderstack/client'
export const bunderstack = createClient({ url: process.env.APP_URL ?? 'http://localhost:3000' })
```

```ts
import { bunderstack } from './client'

const data = await bunderstack.posts.list({ where: { authorId: session.userId } }) // typed
bunderstack.posts.subscribe('create', (post) => { /* post is your Post type */ })   // typed
```

**Sequencing:** typed fetch/REST client first (sufficient to prove the product);
tRPC router + TanStack Query hooks layered on once the core is stable.

---

## Architecture

```
your project
  schema.ts        (Drizzle tables — the single source of truth)
  bunderstack.ts        (createBunderstack({ schema, ... }))
       |
       v
  createBunderstack assembles:
       |
       +-- Drizzle      -> db        (queries + migrations via drizzle-kit)
       +-- BetterAuth   -> auth      (sessions, OAuth, email flows)
       +-- storage      -> local fs | Bun.s3  (+ thumbnail cache)
       +-- realtime     -> broadcast on write + SSE endpoint
       +-- CRUD gen     -> typed REST/RPC routes per table
       |
       v
  app.handler  (req: Request) => Promise<Response>
       |
       +-- mount in TanStack Start  (catch-all route)
       +-- mount in Next.js         (catch-all route)
       +-- serve standalone         (Bun.serve)
```

### Repo structure

```
bunderstack/
  PLAN.md
  src/
    index.ts          createBunderstack() — the composition entry point
    config.ts         read + validate options and environment
    db.ts             Drizzle setup (libSQL local/remote, Postgres later)
    auth.ts           BetterAuth setup + adapter wiring
    storage/
      index.ts        storage abstraction (local | s3)
      thumbnails.ts   sharp transforms + cache
      validation.ts   upload MIME/size/dimension checks
    realtime.ts       broadcast registry + SSE endpoint + typed events
    crud.ts           generate REST/RPC routes from table definitions
    handler.ts        assemble the Hono app -> expose .handler
    client/
      index.ts        runtime client factory
      codegen.ts      emit typed client.ts
    cli.ts            bunderstack dev / db push / db migrate / generate
  package.json
```

---

## Milestones

### Phase 1 — Composition core (week 1–2)

- `createBunderstack({ schema })` returns `{ handler, db, auth, storage, realtime, router }`.
- Drizzle wired (libSQL local; Turso via env).
- `app.handler` mounts and responds in standalone Bun.
- Auto-generated REST CRUD per table (list/get/create/update/delete + filter/page/sort).
- `bunderstack db push` for the instant dev loop.

### Phase 2 — Auth + storage built-ins (week 3–4)

- BetterAuth composed in; `/auth/*` works; auth tables in the shared schema.
- Email/password + one OAuth provider; console email driver for dev.
- Storage abstraction: local fs + S3 via env.
- File upload with validation.
- **Thumbnails**: on-the-fly transforms with cache.

### Phase 3 — Realtime + portability proof (week 5–6)

- SSE subscription endpoint; broadcast on write; typed events.
- Verified mounting in **TanStack Start** and **Next.js** via the fetch handler.
- Honest serverless-realtime documentation.

### Phase 4 — Typed client (week 7+)

- `bunderstack generate` -> typed REST client.
- tRPC router generated from schema; TanStack Query hooks.

### Post-MVP

- Bundled admin UI.
- Postgres backend.
- Redis sessions + pub/sub (multi-instance realtime).
- Per-tenant sharding via Turso database-per-tenant.
- Schema-annotation-driven access rules / row-level authorization.

---

## Open questions

- **Access control model.** PocketBase has per-collection API rules. Where do ours
  live — schema annotations, a separate `rules.ts`, or auth middleware? It shapes
  the schema/config format, so decide before that format is frozen.
- **REST shape.** Match PocketBase's conventions for familiarity, or design a
  cleaner REST surface? Affects the generated client.
- **tRPC vs typed-fetch as the headline client.** tRPC is the better DX and the
  differentiator; typed-fetch is simpler and ships first. Both can coexist.
- **Thumbnail cache location.** Same store as originals (S3/fs) vs. a separate
  cache tier. Probably same store keyed by transform hash; confirm.

---

## What "done" means for the MVP

A developer can:

1. Write `schema.ts` and a one-line `bunderstack.ts` (`createBunderstack({ schema })`).
2. Mount `app.handler` in TanStack Start, Next.js, or standalone Bun.
3. Get working REST CRUD, auth, file uploads with thumbnails, and realtime
   subscriptions.
4. Reach into `app.db` / `app.auth` whenever a built-in isn't enough.
5. Set `DATABASE_URL` + `S3_*` and deploy the same code to production, with
   storage swapped purely by environment.

If that loop works end to end, the concept is proven.
