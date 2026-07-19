# bunderstack

A batteries-included backend framework for Bun. Point it at a Drizzle schema and get CRUD APIs, auth, file storage, realtime, typed custom endpoints (tRPC), email, background jobs + cron, and validated env — all from a single config object and a single `Request → Response` handler you can drop into any runtime.

```ts
import { createBunderstack } from 'bunderstack'
import { provision } from 'bunderstack/provision'
import * as schema from './schema'

const app = await createBunderstack({
  schema,
  auth: { emailAndPassword: { enabled: true } },
  access: {
    posts: { ownerColumn: 'userId', list: 'public', create: 'authenticated' },
  },
})

await provision(app)

Bun.serve({ fetch: app.handler })
```

That's it. You now have:

- `GET /api/posts` — paginated list
- `POST /api/posts` — create (authenticated)
- `PATCH /api/posts/:id` — update (owner only)
- `DELETE /api/posts/:id` — delete (owner only)
- `POST /api/auth/sign-up/email` + `sign-in/email`
- `POST /api/files` + `GET /api/files/:id`

---

## Stack

| Concern          | Library                      |
| ---------------- | ---------------------------- |
| Database         | Drizzle ORM + libSQL / Turso |
| Auth             | BetterAuth                   |
| HTTP routing     | Hono                         |
| Custom endpoints | tRPC (+ superjson)           |
| Storage          | Local disk or S3-compatible  |
| Image transforms | sharp                        |
| Email            | Resend / SMTP / custom       |
| Background jobs  | DB-backed queue + cron       |
| Env validation   | zod (t3-env style)           |
| Runtime          | Bun                          |

---

## Install

```sh
bun add bunderstack drizzle-orm @libsql/client
```

## Define your schema

Auth tables are required by BetterAuth. Add your own tables alongside them.

```ts
// schema.ts
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export * from 'bunderstack/schema'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

// BetterAuth also needs: session, account, verification (same pattern)

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
```

> Import `sqliteTable` and column builders from `bunderstack` (not `drizzle-orm/sqlite-core`) to share the same Drizzle instance and avoid type incompatibilities.

---

## Access control

Every CRUD operation is gated. Rules apply per-table, per-operation.

```ts
const app = await createBunderstack({
  schema,
  access: {
    posts: {
      ownerColumn: 'userId', // column that stores the creator's user ID
      list: 'public', // anyone can list
      get: 'public', // anyone can read one
      create: 'authenticated', // must be logged in
      update: 'owner', // must own the row
      delete: 'owner',
    },
    comments: {
      list: 'public',
      create: 'authenticated',
      update: (ctx) => ctx.user?.id === ctx.row?.userId, // custom rule
      delete: 'owner',
      ownerColumn: 'userId',
    },
  },
})
```

**Rules:** `'public'` · `'authenticated'` · `'owner'` · `'deny'` · `(ctx: AccessContext) => boolean | Promise<boolean>`

**Column guards** restrict what can be written:

```ts
access: {
  posts: {
    readonlyColumns: ['createdAt'],   // ignored on write
    writableColumns: ['title', 'body'], // all others are ignored
  },
}
```

---

## Auth

BetterAuth is pre-configured. Enable email/password and OAuth providers in config:

```ts
auth: {
  emailAndPassword: { enabled: true },
  secret: process.env.AUTH_SECRET,
  socialProviders: {
    github: { clientId: '...', clientSecret: '...' },
    google: { clientId: '...', clientSecret: '...' },
  },
},
```

Auth routes are mounted at `/api/auth/*` automatically.

---

## Email

One config key gives you `app.email.send()` and auto-wired auth emails:

```ts
email: {
  from: 'MyApp <hello@myapp.com>',
  provider: 'resend',   // 'resend' | 'smtp' | 'console' | custom adapter
},
```

- **`resend`** — plain `fetch` to the Resend API, no SDK. Reads `RESEND_API_KEY` (required at boot when this provider is set).
- **`smtp`** — via `nodemailer` (optional peer dependency). Reads `SMTP_URL`.
- **`console`** — pretty-prints the mail to the terminal instead of sending. The default in development when no provider is set; in production an unset provider is a boot error.
- **Custom** — pass `{ send: async (msg) => ({ id }) }` or a bare async function.

```ts
await app.email.send({ to: 'user@example.com', subject: 'Hi', text: '...' })
```

When email is configured, BetterAuth's password-reset and email-verification mails work automatically with plain default templates — handlers you supply in `auth:` always win.

---

## File storage

Upload, retrieve, and delete files. Supports local disk and S3-compatible storage.

```ts
// Local disk
storage: {
  local: './uploads'
}

// S3 (reads S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY from env)
storage: {
  s3: true
}

// S3 with custom endpoint (e.g. Cloudflare R2, MinIO)
storage: {
  s3: {
    endpoint: 'https://your-account.r2.cloudflarestorage.com'
  }
}
```

```ts
// Optional upload rules
storageOptions: {
  uploadRules: {
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxSizeBytes: 10 * 1024 * 1024,
  },
  access: {
    create: 'authenticated',
    get: 'public',
    delete: 'owner',
  },
}
```

**Routes:**

- `POST /api/files` — multipart upload, field name `file`. Returns `{ fileId, url }`.
- `GET /api/files/:id` — serve the file
- `DELETE /api/files/:id` — delete

### Image transforms

Append query params to any image URL to resize or convert on the fly. Transformed images are cached automatically.

```
GET /api/files/photo.jpg?w=400&h=300&format=webp
GET /api/files/avatar.jpg?w=64&h=64
```

---

## Database

Bunderstack exposes the raw Drizzle instance — no query builder abstraction on top.

```ts
const { db } = app

const posts = await db
  .select()
  .from(schema.posts)
  .orderBy(desc(schema.posts.createdAt))

await db
  .insert(schema.posts)
  .values({ title: 'Hello', body: '...', userId: '...' })
```

Database URL defaults to `file:./data.db`. Set `DATABASE_URL` in env or pass `database: { url: '...' }` to use Turso or any libSQL-compatible remote.

```ts
database: { url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN }
```

### Schema provisioning & migrations

One line covers the whole lifecycle — the `migrations/` folder is the mode switch, no NODE_ENV checks:

```ts
import { provision } from 'bunderstack/provision'

const app = await createBunderstack({ schema, ... })
await provision(app)
```

- **No `migrations/` folder** (prototyping) — pushes the schema straight to the database on boot. Requires drizzle-kit as a dev dependency (`bun add -d drizzle-kit`). Refuses pushes that would drop data unless you pass `provision(app, { force: true })`.
- **`migrations/` committed** (stabilized & production) — applies pending migrations via drizzle-orm's built-in migrator. drizzle-kit is never imported, so a fresh clone deploys with `bun install --production`.

When you're done prototyping, generate the initial migration and commit it; from then on every schema change is an explicit step:

```bash
bunx drizzle-kit generate   # writes migrations/
```

Add internal tables to your schema first (`export * from 'bunderstack/schema'`) so migrations include them. The folder location comes from `database: { migrations: './migrations' }` (that's the default — match `out` in `drizzle.config.ts`). Provisioning is opt-in: skip the import entirely and apply migrations from CI if you prefer the framework never touch your database.

---

## Custom endpoints (tRPC)

For non-CRUD endpoints — aggregations, multi-table reads, custom mutations — declare a tRPC router inline in the config. The `t` instance comes pre-wired: procedures get `ctx` of `{ db, user, env, email, req }`, and superjson is the transformer, so Dates, Maps, Sets, and BigInt survive the round trip (return drizzle rows directly).

```ts
import { z } from 'zod'
import { desc, eq, sql } from 'drizzle-orm'

const app = await createBunderstack({
  schema,
  trpc: (t) =>
    t.router({
      feed: t.procedure
        .input(z.object({ limit: z.number().int().max(50).default(20) }))
        .query(({ ctx, input }) =>
          // posts + authors + like counts in ONE request
          ctx.db
            .select({
              post: schema.posts,
              author: { id: schema.user.id, name: schema.user.name },
              likeCount: sql<number>`count(${schema.likes.id})`,
            })
            .from(schema.posts)
            .innerJoin(schema.user, eq(schema.posts.userId, schema.user.id))
            .leftJoin(schema.likes, eq(schema.likes.postId, schema.posts.id))
            .groupBy(schema.posts.id)
            .orderBy(desc(schema.posts.createdAt))
            .limit(input.limit),
        ),
      deleteAccount: t.protectedProcedure // UNAUTHORIZED without a session; ctx.user is non-null
        .mutation(({ ctx }) => { /* ... */ }),
    }),
})
```

The router mounts at `/api/trpc/*`. On the client, `api.trpc.*` is fully typed from the server app (see [bunderstack-query](#client-bunderstack-query)):

```ts
const { data } = useQuery(api.trpc.feed.queryOptions({ limit: 20 }))
const del = useMutation(api.trpc.deleteAccount.mutationOptions())
```

`t.router`, `t.middleware`, and `t.mergeRouters` are plain tRPC — nested routers compose as usual. When the app outgrows the inline callback, pass a prebuilt router instead and build sub-routers in separate files with `createTRPC<typeof schema>()` from `bunderstack/trpc`.

---

## Env validation

Bunderstack always validates its own env vars at boot (`DATABASE_URL`, `AUTH_SECRET` — required in production, `REDIS_URL`, email provider credentials). Declare your own on top, t3-env style; the app refuses to start with a single aggregated error listing every missing or invalid var.

```ts
import { z } from 'zod'

const app = await createBunderstack({
  schema,
  env: {
    server: { OPENAI_API_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string().url() }, // client keys must be PUBLIC_-prefixed
  },
})

app.env.OPENAI_API_KEY // typed + validated; also available as ctx.env in tRPC procedures
```

Browser side, `createClientEnv` from the server-code-free `bunderstack/env` subpath validates only the `client` section — and accessing a server key from it throws instead of silently reading `undefined`. Values resolve from `process.env.PUBLIC_*` (inline them with `bun build --env 'PUBLIC_*'`) or a `runtimeEnv` override for bundlers like Vite.

---

## Framework adapters

### Standalone (Bun)

```ts
import { createBunderstack } from 'bunderstack'
import { provision } from 'bunderstack/provision'
import * as schema from './schema'

const app = await createBunderstack({
  schema,
  auth: { emailAndPassword: { enabled: true } },
})

await provision(app)

Bun.serve({ port: 3001, fetch: app.handler })
```

### Next.js

```ts
// app/api/[...bunderstack]/route.ts
import { getApp } from '@/bunderstack'

export async function GET(req: Request) {
  return (await getApp()).handler(req)
}
export const POST = GET
export const PATCH = GET
export const DELETE = GET
```

### TanStack Start: bunderstack-start

The `bunderstack-start` adapter owns all Start-specific glue — SSR-aware
fetch, the API file route, session lookup, and the auth client:

```ts
// src/bunderstack.ts (server)
export const app = await createBunderstack({ schema, access, storage, realtime: true })
export type App = typeof app

// src/api.ts — the entire client setup
// (don't name it client.ts — that's a reserved Start entry-point name)
import { bunderstackStart } from 'bunderstack-start'
import type { App } from './bunderstack'
export const { createQueryClient, createApi } = bunderstackStart<App>()

// src/routes/api/$.tsx
import { createApiHandlers } from 'bunderstack-start'
import { app } from '~/bunderstack'
export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})
```

Tables and buckets are inferred from `App` — no tuples to keep in sync with
the server. Realtime defaults to on in the browser and off during SSR.
`getSessionUser(app, request)` resolves the BetterAuth session in server
functions, and `createStartAuthClient()` is the browser auth SDK.

---

## Background work: jobs, workers, and cron

`createBunderstack()` only constructs the application. It never starts a
worker, scheduler, or maintenance timer implicitly. This keeps the web process
safe to scale to zero and makes background ownership explicit.

Declare durable queue jobs and platform-delivered cron tasks together:

```ts
import { z } from 'zod'

const app = await createBunderstack({
  schema,
  jobs: (j) =>
    j.define({
      sendReceipt: j.job({
        input: z.object({ orderId: z.string() }),
        retries: 5,
        handler: async ({ orderId }, ctx) => {
          // durable work: use ctx.db, ctx.email, ctx.storage, ctx.jobs
        },
      }),
      removeExpiredSessions: j.cron({
        schedule: '0 * * * *', // five-field UTC cron
        handler: async ({ scheduledFor }, ctx) => {
          // scheduled work; it is not a queue job and cannot be enqueued
        },
      }),
    }),
})

await app.jobs.enqueue('sendReceipt', { orderId: 'ord_123' })
```

`j.job()` names are the only names accepted by `app.jobs.enqueue()`. Queue
delivery is at-least-once, so handlers should be idempotent. `j.cron()` is a
separate contract: the hosting platform delivers matching schedule slots to
the web application over authenticated HTTP.

Run the web server and the worker as distinct processes in production:

```ts
// server.ts
import { app } from './bunderstack'

Bun.serve({ fetch: app.handler })
```

```ts
// worker.ts
import { app } from './bunderstack'

await app.runWorker() // handles SIGINT/SIGTERM, then closes app resources
```

For embedded development, use a closeable handle instead:

```ts
const worker = await app.startWorker({ pollIntervalMs: 250 })
// ...
await worker.close()
```

For local standalone development only, Bunderstack can act as the clock:

```ts
const scheduler = await app.startCronScheduler()
// ...
await scheduler.close()
```

Production cron delivery is mounted at
`POST /api/_bunderstack/cron/:name`; storage maintenance is at
`POST /api/_bunderstack/maintenance/storage-sweep`. Production requires
`BUNDERSTACK_CRON_SECRET`; the platform signs each task name and UTC minute
slot. Do not expose or call these endpoints from browser code. Bunderhost
reads `app.manifest.background`: queue jobs cause a separate always-on worker
deployment, while cron-only applications remain web-only and can still scale to
zero between requests.

---

## Client: bunderstack-query

A companion TanStack Query client with full type inference from your server
app — a type-only import, so no server code lands in the bundle:

```sh
bun add bunderstack-query @tanstack/react-query
```

```ts
// api-client.ts
import { createClient } from 'bunderstack-query'
import { QueryClient } from '@tanstack/react-query'
import type { App } from './bunderstack' // type-only import

export const queryClient = new QueryClient()

// Exposed tables and buckets are inferred from the server's access +
// storage config; clients materialize lazily on first property access.
// (Object.keys(api) is empty by design — it's a lazy Proxy.)
export const api = createClient<App>({ queryClient })
```

Every exposed table gets a full typed client:

```ts
// In a component
const { data } = useQuery(api.posts.listQuery({ limit: 20, offset: 0 }))
// data: { items: Post[], limit: number, offset: number }

const create = useMutation(api.posts.createMutation())
const update = useMutation(api.posts.updateMutation())
const remove = useMutation(api.posts.deleteMutation())
```

If the server declares a `trpc` router, the client grows a typed `trpc` namespace (backed by tRPC's official TanStack Query integration — same `queryOptions`/`mutationOptions` shape as the table clients):

```ts
const { data } = useQuery(api.trpc.feed.queryOptions({ limit: 20 }))
// data's type is inferred from the procedure's return — Dates included
```

**Explicit alternatives** — `createBunderstackQueryClient<typeof schema>().withTables({ tables: [...] })` (hand-picked table tuple) and `.withSchema({ schema })` (schema imported as a value) still work when you want explicit control instead of app-type inference.

### Sync collections: bunderstack-sync

`createSyncClient<App>()` layers TanStack DB collections on top — same
inference, plus live-query collections with realtime fan-out:

```ts
import { createSyncClient } from 'bunderstack-sync'
import type { App } from './bunderstack'

const api = createSyncClient<App>({ queryClient })

// Default capped collection + raw table client
api.posts.collection
api.posts.table.list({ limit: 20 })

// Growing-window pagination (cursor-walking, cached by options):
const feed = api.posts.scopedCollection({
  filter: { replyToId: null },
  sort: 'createdAt',
  order: 'desc',
})
feed.collection // use with useLiveQuery
await feed.loadMore() // grow the window in place — no scroll jumps
feed.hasMore() // exact, from the server's last response

// Resolve exactly these rows (chunked at the server's IN-filter cap):
const authors = api.user.collectionByIds(authorIds)

// Files + realtime
api.files.avatars.upload(file)
api.realtime?.subscribe(['posts', 'user'])
```

Realtime events fan out to every materialized view of a table — the base
collection, scoped windows (filtered client-side by each window's own
predicate), and byIds sets. `MAX_LIST_LIMIT` (200, the server's per-request
cap) is exported from both `bunderstack` and `bunderstack-query`.

---

## Configuration reference

```ts
await createBunderstack({
  schema,                    // Drizzle schema object (required)

  database: {
    url: 'file:./data.db',   // libSQL URL. Defaults to DATABASE_URL env var.
    authToken: '...',        // For Turso. Defaults to DATABASE_AUTH_TOKEN env var.
  },

  auth: {
    emailAndPassword: { enabled: true }, // Enable email/password auth
    secret: '...',                       // JWT secret. Defaults to AUTH_SECRET env var.
    socialProviders: {
      github: { clientId: '...', clientSecret: '...' },
      google: { clientId: '...', clientSecret: '...' },
    },
  },

  storage: { local: './uploads' },  // or { s3: true } / { s3: { endpoint } }

  env: {
    server: { OPENAI_API_KEY: z.string() },      // validated at boot, typed on app.env
    client: { PUBLIC_APP_URL: z.string().url() }, // PUBLIC_-prefixed, browser-safe
  },

  email: {
    from: 'MyApp <hello@myapp.com>',
    provider: 'resend',            // 'resend' | 'smtp' | 'console' | custom adapter
  },

  trpc: (t) => t.router({ ... }),  // or a prebuilt router; mounted at /api/trpc/*

  realtime: true,                  // SSE broadcast-on-write; optional { redis } for multi-instance

  access: {
    tableName: {
      ownerColumn: 'userId',
      list: 'public',
      get: 'public',
      create: 'authenticated',
      update: 'owner',
      delete: 'owner',
      writableColumns: ['title', 'body'],
      readonlyColumns: ['createdAt'],
      searchableColumns: ['title', 'body'], // enables ?q= search on list
    },
  },

  storageOptions: {
    uploadRules: { allowedMimeTypes: [...], maxSizeBytes: 10_000_000 },
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
  },
})
```

---

### Publishing custom writes to realtime

Generated CRUD publishes automatically. Writes made directly through `app.db`
or `ctx.db` are explicit: publish the complete row returned by Drizzle after the
write commits.

```ts
const [avatar] = await ctx.db
  .update(schema.avatars)
  .set({ status: 'completed' })
  .where(eq(schema.avatars.id, avatarId))
  .returning()

await ctx.realtime.publish(schema.avatars, 'update', avatar)
```

The same typed facade is available as `app.realtime`, in tRPC context, and in
queue-job and cron context. Passing the Drizzle table makes a table-name typo a
type error and constrains the record to that table's select model.

Publish after an enclosing transaction resolves, not from inside it. The full
row is required because realtime access filtering may inspect its `id`, owner,
or read-scope columns. Subscriber access checks, Redis fan-out, and replay are
applied automatically by the existing broker. When server realtime is not
configured, `realtime.enabled` is `false` and `publish()` is a no-op.

## Development

```sh
bun install

# Run an example
bun run dev:twitter-tanstack

# Run tests
bun test
```

Examples are in [`examples/`](./examples) — Twitter clones (TanStack Start, with a tRPC `feed` showcase; TanStack DB + shadcn), kanban boards (Solid, TanStack), and a collaborative tldraw canvas.
