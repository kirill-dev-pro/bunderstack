# bunderstack

A batteries-included backend framework for Bun. Point it at a Drizzle schema and get CRUD APIs, auth, and file storage — all from a single `Request → Response` handler you can drop into any runtime.

```ts
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

const app = createBunderstack({
  schema,
  auth: { emailAndPassword: { enabled: true } },
  access: {
    posts: { ownerColumn: 'userId', list: 'public', create: 'authenticated' },
  },
})

if (process.env.NODE_ENV !== 'production') {
  await app.provision()
}

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
| Storage          | Local disk or S3-compatible  |
| Image transforms | sharp                        |
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
import { sqliteTable, integer, text } from 'bunderstack'

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
const app = createBunderstack({
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

Bunderstack follows Drizzle's lifecycle: **push** (dev), **generate** (author migrations), **migrate** (production).

1. Add internal tables to your schema: `export * from 'bunderstack/schema'`
2. **Development** — push on startup:

```ts
const app = createBunderstack({ schema, ... })
if (process.env.NODE_ENV !== 'production') {
  await app.provision()  // drizzle-kit push via drizzle-kit/api
}
```

3. **Production** — versioned migrations:

```bash
bunx drizzle-kit generate   # writes migrations/
bunx drizzle-kit migrate    # apply before starting the server
```

`app.provision()` always pushes when called (no NODE_ENV gating). Use `app.provision({ force: true })` if the push would cause data loss.

---

## Framework adapters

### Standalone (Bun)

```ts
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

const app = createBunderstack({
  schema,
  auth: { emailAndPassword: { enabled: true } },
})

if (process.env.NODE_ENV !== 'production') {
  await app.provision()
}

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
export const app = createBunderstack({ schema, access, storage, realtime: true })
export type App = typeof app

// src/client.ts — the entire client setup
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
createBunderstack({
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

## Development

```sh
bun install

# Run standalone example
bun dev

# Run tests
bun test

# Push schema to DB
bun db:push
```

Examples are in [`examples/`](./examples) — standalone Bun server, Next.js, and TanStack Start.
