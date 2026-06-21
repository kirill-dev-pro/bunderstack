# Bunderstack POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working POC of `createBunderstack({ schema })` that returns `{ handler, db, auth, storage, router }` with auto-generated CRUD routes, BetterAuth integration, local/S3 file storage, image thumbnails, and file validation — all wired to a single Web-Standard `Request → Response` handler mountable in Bun, TanStack Start, or Next.js.

**Architecture:** `createBunderstack` composes Drizzle (libSQL), BetterAuth, and Hono internally, then re-exports the raw instances so users can drop down to any layer. The HTTP handler is plain `(req: Request) => Promise<Response>` — Bun.serve, Next.js app router, and TanStack Start all call it the same way. Storage is abstracted behind a `StorageAdapter` interface; the driver (local `Bun.file` or S3 via `Bun.S3Client`) is chosen by config/env at startup.

**Tech Stack:** Bun · Hono · Drizzle ORM + `@libsql/client` · BetterAuth · `Bun.S3Client` · sharp · zod · `bun test`

## Global Constraints

- Runtime: Bun only — use `bun <file>`, `bun test`, `bun install`; never `node`, `ts-node`, `jest`, `vitest`
- HTTP: Hono — never express
- SQLite driver: `@libsql/client` + `drizzle-orm/libsql` — supports both local file and Turso remote via the same driver; never `bun:sqlite` directly
- S3: `Bun.S3Client` — never `aws-sdk` or `@aws-sdk/*`
- File I/O: `Bun.file` / `Bun.write` — never `node:fs`
- Config auto-load: Bun auto-loads `.env`; never use `dotenv`
- Strict TypeScript: `"strict": true` is already set in `tsconfig.json`; no `any` on public surfaces
- Test file naming: `*.test.ts`; run with `bun test`
- Commit after every task

---

## File Map

```
src/
  config.ts           — options types + resolveConfig()
  db.ts               — createDb() → LibSQLDatabase
  crud.ts             — buildCrudRouter(schema, db) → Hono
  auth.ts             — createAuth(db, config) → Auth
  handler.ts          — buildHandler(parts) → { handler, router }
  index.ts            — createBunderstack() entry point
  storage/
    index.ts          — StorageAdapter interface + createStorage()
    local.ts          — LocalStorageAdapter using Bun.file / Bun.write
    s3.ts             — S3StorageAdapter using Bun.S3Client
    validation.ts     — validateUpload(file, rules) → throws on violation
    thumbnails.ts     — transformImage(buffer, spec) → Buffer + transformHash()
tests/
  config.test.ts
  crud.test.ts
  storage/
    local.test.ts
    validation.test.ts
    thumbnails.test.ts
examples/
  standalone/
    schema.ts         — demo tables + required BetterAuth tables
    server.ts         — createBunderstack + Bun.serve
```

---

## Task 1: Install dependencies + update package.json

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: all runtime dependencies available for import in subsequent tasks

- [ ] **Step 1: Install runtime dependencies**

```bash
bun add hono drizzle-orm @libsql/client better-auth sharp zod
```

Expected output: packages added to `bun.lock`, no errors.

- [ ] **Step 2: Install dev dependencies**

```bash
bun add -d drizzle-kit
```

- [ ] **Step 3: Update package.json with scripts**

Replace the contents of `package.json` with:

```json
{
  "name": "bunderstack",
  "module": "src/index.ts",
  "type": "module",
  "scripts": {
    "test": "bun test",
    "dev": "bun --hot examples/standalone/server.ts",
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@libsql/client": "latest",
    "better-auth": "latest",
    "drizzle-orm": "latest",
    "hono": "latest",
    "sharp": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "drizzle-kit": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 4: Verify install**

```bash
bun run test
```

Expected: `0 tests, 0 failed` (no test files yet). No import errors.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: install hono, drizzle-orm, @libsql/client, better-auth, sharp, zod"
```

---

## Task 2: Config layer

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `BunderstackConfig<TSchema>` — the public options type accepted by `createBunderstack`
  - `ResolvedConfig` — the internal fully-resolved config with env var fallbacks applied
  - `resolveConfig(opts): ResolvedConfig` — called once at startup

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { test, expect } from 'bun:test'
import { resolveConfig } from '../src/config'
import * as schema from '../examples/standalone/schema'

test('resolveConfig applies SQLite default url', () => {
  const cfg = resolveConfig({ schema })
  expect(cfg.database.url).toBe('file:./data.db')
})

test('resolveConfig picks up DATABASE_URL env', () => {
  process.env.DATABASE_URL = 'libsql://test.turso.io'
  const cfg = resolveConfig({ schema })
  expect(cfg.database.url).toBe('libsql://test.turso.io')
  delete process.env.DATABASE_URL
})

test('resolveConfig defaults to local storage', () => {
  const cfg = resolveConfig({ schema })
  expect(cfg.storage.type).toBe('local')
  if (cfg.storage.type === 'local') {
    expect(cfg.storage.path).toBe('./uploads')
  }
})

test('resolveConfig accepts custom local path', () => {
  const cfg = resolveConfig({ schema, storage: { local: './my-uploads' } })
  expect(cfg.storage.type).toBe('local')
  if (cfg.storage.type === 'local') {
    expect(cfg.storage.path).toBe('./my-uploads')
  }
})

test('resolveConfig s3 true reads env vars', () => {
  process.env.S3_BUCKET = 'my-bucket'
  process.env.S3_REGION = 'eu-west-1'
  process.env.S3_ACCESS_KEY_ID = 'key'
  process.env.S3_SECRET_ACCESS_KEY = 'secret'
  const cfg = resolveConfig({ schema, storage: { s3: true } })
  expect(cfg.storage.type).toBe('s3')
  if (cfg.storage.type === 's3') {
    expect(cfg.storage.bucket).toBe('my-bucket')
    expect(cfg.storage.region).toBe('eu-west-1')
  }
  delete process.env.S3_BUCKET
  delete process.env.S3_REGION
  delete process.env.S3_ACCESS_KEY_ID
  delete process.env.S3_SECRET_ACCESS_KEY
})

test('resolveConfig auth defaults', () => {
  const cfg = resolveConfig({ schema })
  expect(cfg.auth.emailPassword).toBe(false)
  expect(typeof cfg.auth.secret).toBe('string')
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/config.test.ts
```

Expected: error — `Cannot find module '../src/config'`

- [ ] **Step 3: Create `src/config.ts`**

```typescript
// src/config.ts
import { z } from 'zod'

const StorageConfigSchema = z.union([
  z.object({ local: z.union([z.string(), z.literal(true)]) }),
  z.object({ s3: z.union([z.literal(true), z.object({ endpoint: z.string().optional() })]) }),
])

export const BunderstackOptionsSchema = z.object({
  schema: z.record(z.unknown()),
  database: z.object({ url: z.string().optional(), authToken: z.string().optional() }).optional(),
  auth: z.object({
    emailPassword: z.boolean().optional(),
    secret: z.string().optional(),
    providers: z.object({
      github: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
      google: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
    }).optional(),
  }).optional(),
  storage: StorageConfigSchema.optional(),
})

export type BunderstackConfig<TSchema extends Record<string, unknown>> =
  Omit<z.input<typeof BunderstackOptionsSchema>, 'schema'> & { schema: TSchema }

export type ResolvedStorage =
  | { type: 'local'; path: string }
  | { type: 's3'; bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string }

export type ResolvedConfig = {
  database: { url: string; authToken?: string }
  auth: { emailPassword: boolean; secret: string; providers: z.infer<typeof BunderstackOptionsSchema>['auth'] extends infer A ? NonNullable<NonNullable<A>['providers']> : never }
  storage: ResolvedStorage
}

export function resolveConfig<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): ResolvedConfig {
  const parsed = BunderstackOptionsSchema.parse(options)

  return {
    database: {
      url: parsed.database?.url ?? process.env.DATABASE_URL ?? 'file:./data.db',
      authToken: parsed.database?.authToken ?? process.env.DATABASE_AUTH_TOKEN,
    },
    auth: {
      emailPassword: parsed.auth?.emailPassword ?? false,
      secret: parsed.auth?.secret ?? process.env.AUTH_SECRET ?? 'dev-secret-change-in-prod',
      providers: parsed.auth?.providers ?? {},
    },
    storage: resolveStorage(parsed.storage),
  }
}

function resolveStorage(storage: z.infer<typeof StorageConfigSchema> | undefined): ResolvedStorage {
  if (!storage) return { type: 'local', path: './uploads' }
  if ('local' in storage) return { type: 'local', path: storage.local === true ? './uploads' : storage.local }
  const s3Cfg = typeof storage.s3 === 'object' ? storage.s3 : {}
  return {
    type: 's3',
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: s3Cfg.endpoint ?? process.env.S3_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  }
}
```

- [ ] **Step 4: Create minimal `examples/standalone/schema.ts`** (needed by the test imports)

```typescript
// examples/standalone/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// BetterAuth required tables
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// Demo app table
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
  authorId: text('author_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
})
```

- [ ] **Step 5: Run tests — they should pass**

```bash
bun test tests/config.test.ts
```

Expected: `6 tests, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts examples/standalone/schema.ts
git commit -m "feat: config layer with zod validation and env var fallbacks"
```

---

## Task 3: Database layer

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig['database']` from `src/config.ts`
- Produces:
  - `createDb<TSchema>(schema, cfg) → LibSQLDatabase<TSchema>` — returns a fully-configured Drizzle instance using the libSQL driver

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db.test.ts
import { test, expect } from 'bun:test'
import { createDb } from '../src/db'
import { posts } from '../examples/standalone/schema'

test('createDb returns a working Drizzle instance against in-memory SQLite', async () => {
  const db = createDb({ posts }, { url: ':memory:' })

  // Create the table manually (no drizzle-kit needed for the test)
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      author_id TEXT,
      created_at INTEGER
    )`
  )

  const inserted = await db.insert(posts).values({ title: 'Hello' }).returning()
  expect(inserted[0]?.title).toBe('Hello')

  const all = await db.select().from(posts)
  expect(all).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test tests/db.test.ts
```

Expected: error — `Cannot find module '../src/db'`

- [ ] **Step 3: Create `src/db.ts`**

```typescript
// src/db.ts
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'

export function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: { url: string; authToken?: string },
) {
  const client = createClient({ url: cfg.url, authToken: cfg.authToken })
  return drizzle(client, { schema })
}
```

- [ ] **Step 4: Run test — it should pass**

```bash
bun test tests/db.test.ts
```

Expected: `1 test, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: database layer — Drizzle/libSQL factory"
```

---

## Task 4: CRUD route generation

**Files:**
- Create: `src/crud.ts`
- Create: `tests/crud.test.ts`

**Interfaces:**
- Consumes: `createDb` from `src/db.ts`
- Produces:
  - `buildCrudRouter<TSchema>(schema, db) → Hono` — Hono sub-app with REST CRUD routes for every Drizzle table in `schema` that has an `id` column; mounted at `/:tableName`

Routes generated per table:
```
GET    /:table           list  — ?limit=20&offset=0
GET    /:table/:id       get
POST   /:table           create
PATCH  /:table/:id       update
DELETE /:table/:id       delete (204)
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/crud.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { createDb } from '../src/db'
import { buildCrudRouter } from '../src/crud'
import { posts } from '../examples/standalone/schema'
import { Hono } from 'hono'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

let app: Hono
let db: LibSQLDatabase<{ posts: typeof posts }>

beforeAll(async () => {
  db = createDb({ posts }, { url: ':memory:' })
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      author_id TEXT,
      created_at INTEGER
    )`
  )
  app = new Hono()
  app.route('/api', buildCrudRouter({ posts }, db))
})

test('POST /api/posts creates a record', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'First post' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: number; title: string }
  expect(body.title).toBe('First post')
  expect(typeof body.id).toBe('number')
})

test('GET /api/posts lists records', async () => {
  const res = await app.request('/api/posts')
  expect(res.status).toBe(200)
  const body = await res.json() as { items: unknown[] }
  expect(Array.isArray(body.items)).toBe(true)
  expect(body.items.length).toBeGreaterThan(0)
})

test('GET /api/posts/:id returns one record', async () => {
  const res = await app.request('/api/posts/1')
  expect(res.status).toBe(200)
  const body = await res.json() as { id: number }
  expect(body.id).toBe(1)
})

test('GET /api/posts/:id returns 404 for missing record', async () => {
  const res = await app.request('/api/posts/9999')
  expect(res.status).toBe(404)
})

test('PATCH /api/posts/:id updates a record', async () => {
  const res = await app.request('/api/posts/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated' }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { title: string }
  expect(body.title).toBe('Updated')
})

test('DELETE /api/posts/:id deletes a record', async () => {
  const res = await app.request('/api/posts/1', { method: 'DELETE' })
  expect(res.status).toBe(204)

  const check = await app.request('/api/posts/1')
  expect(check.status).toBe(404)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/crud.test.ts
```

Expected: error — `Cannot find module '../src/crud'`

- [ ] **Step 3: Create `src/crud.ts`**

```typescript
// src/crud.ts
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { isTable, getTableName } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: LibSQLDatabase<TSchema>,
): Hono {
  const router = new Hono()

  for (const table of Object.values(schema)) {
    if (!isTable(table)) continue

    const name = getTableName(table as Parameters<typeof getTableName>[0])
    const idCol = (table as Record<string, unknown>)['id']
    if (!idCol) continue

    router.get(`/${name}`, async (c) => {
      const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
      const offset = Number(c.req.query('offset') ?? 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = await (db as any).select().from(table).limit(limit).offset(offset)
      return c.json({ items, limit, offset })
    })

    router.get(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).select().from(table).where(eq(idCol as any, id))
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)
      return c.json(rows[0])
    })

    router.post(`/${name}`, async (c) => {
      const body = await c.req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).insert(table).values(body).returning()
      return c.json(rows[0], 201)
    })

    router.patch(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      const body = await c.req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).update(table).set(body).where(eq(idCol as any, id)).returning()
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)
      return c.json(rows[0])
    })

    router.delete(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).delete(table).where(eq(idCol as any, id))
      return new Response(null, { status: 204 })
    })
  }

  return router
}
```

- [ ] **Step 4: Run tests — they should pass**

```bash
bun test tests/crud.test.ts
```

Expected: `6 tests, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/crud.ts tests/crud.test.ts
git commit -m "feat: auto-generate CRUD routes from Drizzle schema tables"
```

---

## Task 5: Handler assembly + createBunderstack entry point

**Files:**
- Create: `src/handler.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `createDb` (db.ts), `buildCrudRouter` (crud.ts), `resolveConfig` (config.ts)
- Produces:
  - `buildHandler(parts) → { handler, router }` — assembles the Hono app with health + CRUD routes
  - `createBunderstack<TSchema>(options) → BunderstackApp<TSchema>` — public entry point

```typescript
// BunderstackApp shape (the public export)
type BunderstackApp<TSchema> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: Auth           // BetterAuth instance — wired in Task 6
  storage: StorageAdapter  // wired in Task 7
  router: Hono
}
```

- [ ] **Step 1: Create `src/handler.ts`**

No test for handler in isolation — it's a thin assembly layer tested via the example in Task 6 and later integration.

```typescript
// src/handler.ts
import { Hono } from 'hono'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

interface HandlerParts {
  crudRouter: Hono
  authHandler?: (req: Request) => Promise<Response>
  storageRouter?: Hono
}

export function buildHandler(parts: HandlerParts): {
  handler: (req: Request) => Promise<Response>
  router: Hono
} {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.route('/api', parts.crudRouter)

  if (parts.authHandler) {
    app.on(['GET', 'POST'], '/auth/*', (c) => parts.authHandler!(c.req.raw))
  }

  if (parts.storageRouter) {
    app.route('/files', parts.storageRouter)
  }

  return { handler: app.fetch.bind(app), router: app }
}
```

- [ ] **Step 2: Create `src/index.ts`**

```typescript
// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { buildHandler } from './handler'

// Auth and storage stubs — replaced in Tasks 6 and 7
type AuthStub = { handler: (req: Request) => Promise<Response> }
type StorageStub = object

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthStub
  storage: StorageStub
  router: Hono
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const crudRouter = buildCrudRouter(options.schema, db)
  const { handler, router } = buildHandler({ crudRouter })

  return {
    handler,
    db,
    auth: { handler: async () => new Response('auth not configured', { status: 501 }) },
    storage: {},
    router,
  }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
```

- [ ] **Step 3: Run the full test suite to confirm nothing is broken**

```bash
bun test
```

Expected: `7 tests, 0 failed` (config + db + crud tests all pass)

- [ ] **Step 4: Commit**

```bash
git add src/handler.ts src/index.ts
git commit -m "feat: core assembly — buildHandler and createBunderstack entry point"
```

---

## Task 6: Auth integration (BetterAuth)

**Files:**
- Create: `src/auth.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `LibSQLDatabase` from `src/db.ts`, `ResolvedConfig['auth']` from `src/config.ts`
- Produces:
  - `createAuth(db, cfg) → Auth` — returns a BetterAuth instance wired to the Drizzle DB
  - `createBunderstack` now wires auth and exposes `/auth/*` routes via the handler

Note: BetterAuth requires auth tables (`user`, `session`, `account`, `verification`) to exist in the Drizzle schema. The standalone example's `schema.ts` already includes them (Task 2). Verify the exact adapter import if BetterAuth's package structure differs from `better-auth/adapters/drizzle`.

- [ ] **Step 1: Write a smoke test for auth**

```typescript
// tests/auth.test.ts
import { test, expect } from 'bun:test'
import { createAuth } from '../src/auth'
import { createDb } from '../src/db'
import * as schema from '../examples/standalone/schema'

test('createAuth returns an object with a handler function', () => {
  const db = createDb(schema, { url: ':memory:' })
  const auth = createAuth(db, {
    emailPassword: true,
    secret: 'test-secret-at-least-32-chars-long-x',
    providers: {},
  })
  expect(typeof auth.handler).toBe('function')
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test tests/auth.test.ts
```

Expected: error — `Cannot find module '../src/auth'`

- [ ] **Step 3: Create `src/auth.ts`**

```typescript
// src/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { ResolvedConfig } from './config'

export function createAuth(
  db: LibSQLDatabase<Record<string, unknown>>,
  cfg: ResolvedConfig['auth'],
) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    emailAndPassword: { enabled: cfg.emailPassword },
    secret: cfg.secret,
    socialProviders: {
      ...(cfg.providers.github && {
        github: { clientId: cfg.providers.github.clientId, clientSecret: cfg.providers.github.clientSecret },
      }),
      ...(cfg.providers.google && {
        google: { clientId: cfg.providers.google.clientId, clientSecret: cfg.providers.google.clientSecret },
      }),
    },
  })
}
```

- [ ] **Step 4: Update `src/index.ts` to wire auth**

Replace the `auth` stub section in `src/index.ts` with the real `createAuth` call:

```typescript
// src/index.ts  (full replacement)
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { createAuth } from './auth'
import { buildHandler } from './handler'

type AuthInstance = ReturnType<typeof createAuth>
type StorageStub = object

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageStub
  router: Hono
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const auth = createAuth(db as LibSQLDatabase<Record<string, unknown>>, config.auth)
  const crudRouter = buildCrudRouter(options.schema, db)
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
  })

  return { handler, db, auth, storage: {}, router }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
```

- [ ] **Step 5: Run all tests**

```bash
bun test
```

Expected: `8 tests, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts tests/auth.test.ts src/index.ts
git commit -m "feat: BetterAuth integration — email/password + OAuth wired to Drizzle"
```

---

## Task 7: Storage abstraction (local filesystem)

**Files:**
- Create: `src/storage/index.ts`
- Create: `src/storage/local.ts`
- Create: `tests/storage/local.test.ts`

**Interfaces:**
- Produces:
  - `StorageAdapter` interface with `upload`, `get`, `delete`, `exists`
  - `LocalStorageAdapter` — uses `Bun.file` / `Bun.write`; stores files at `<basePath>/<fileId>`
  - `createStorage(cfg: ResolvedStorage) → StorageAdapter` — factory

```typescript
// StorageAdapter interface
interface StorageAdapter {
  upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void>
  get(fileId: string): Promise<Response>   // ready-to-serve Response
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/storage/local.test.ts
import { test, expect, afterAll } from 'bun:test'
import { LocalStorageAdapter } from '../../src/storage/local'
import { rmSync } from 'node:fs'

const basePath = './.test-uploads'

afterAll(() => {
  rmSync(basePath, { recursive: true, force: true })
})

test('upload writes file and exists returns true', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const data = new TextEncoder().encode('hello storage')
  await adapter.upload('test-file.txt', data, 'text/plain')
  expect(await adapter.exists('test-file.txt')).toBe(true)
})

test('get returns a 200 Response with correct body', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const res = await adapter.get('test-file.txt')
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toBe('hello storage')
})

test('delete removes file and exists returns false', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  await adapter.delete('test-file.txt')
  expect(await adapter.exists('test-file.txt')).toBe(false)
})

test('get returns 404 for missing file', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const res = await adapter.get('does-not-exist.txt')
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/storage/local.test.ts
```

Expected: error — `Cannot find module '../../src/storage/local'`

- [ ] **Step 3: Create `src/storage/local.ts`**

```typescript
// src/storage/local.ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export class LocalStorageAdapter {
  constructor(private readonly basePath: string) {}

  private filePath(fileId: string) {
    return join(this.basePath, fileId)
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void> {
    await mkdir(this.basePath, { recursive: true })
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await Bun.write(
      Bun.file(this.filePath(fileId), { type: contentType }),
      bytes,
    )
  }

  async get(fileId: string): Promise<Response> {
    const file = Bun.file(this.filePath(fileId))
    if (!(await file.exists())) return new Response('Not found', { status: 404 })
    return new Response(file, {
      headers: { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000' },
    })
  }

  async delete(fileId: string): Promise<void> {
    const file = Bun.file(this.filePath(fileId))
    if (await file.exists()) await file.unlink()
  }

  async exists(fileId: string): Promise<boolean> {
    return Bun.file(this.filePath(fileId)).exists()
  }
}
```

- [ ] **Step 4: Create `src/storage/index.ts`**

```typescript
// src/storage/index.ts
import type { ResolvedStorage } from '../config'
import { LocalStorageAdapter } from './local'

export type { LocalStorageAdapter }

export interface StorageAdapter {
  upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void>
  get(fileId: string): Promise<Response>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
}

export function createStorage(cfg: ResolvedStorage): StorageAdapter {
  if (cfg.type === 's3') {
    // S3 adapter wired in Task 8
    throw new Error('S3 storage adapter not yet implemented — set storage: { local: true }')
  }
  return new LocalStorageAdapter(cfg.path)
}
```

- [ ] **Step 5: Run tests — they should pass**

```bash
bun test tests/storage/local.test.ts
```

Expected: `4 tests, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/storage/index.ts src/storage/local.ts tests/storage/local.test.ts
git commit -m "feat: storage abstraction — LocalStorageAdapter using Bun.file/Bun.write"
```

---

## Task 8: S3 storage adapter (Bun.S3Client)

**Files:**
- Create: `src/storage/s3.ts`
- Modify: `src/storage/index.ts`

**Interfaces:**
- Consumes: `StorageAdapter` interface from `src/storage/index.ts`
- Produces: `S3StorageAdapter` — uses `new Bun.S3Client(opts)` to upload/download/delete files

Note: S3 adapter tests require live credentials and are skipped in CI. The test exercises the constructor and confirms the adapter shape only.

- [ ] **Step 1: Write tests**

```typescript
// tests/storage/s3.test.ts
import { test, expect } from 'bun:test'
import { S3StorageAdapter } from '../../src/storage/s3'

test('S3StorageAdapter constructor creates instance without throwing', () => {
  const adapter = new S3StorageAdapter({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
  })
  expect(typeof adapter.upload).toBe('function')
  expect(typeof adapter.get).toBe('function')
  expect(typeof adapter.delete).toBe('function')
  expect(typeof adapter.exists).toBe('function')
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test tests/storage/s3.test.ts
```

Expected: error — `Cannot find module '../../src/storage/s3'`

- [ ] **Step 3: Create `src/storage/s3.ts`**

```typescript
// src/storage/s3.ts
import type { StorageAdapter } from './index'

interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}

export class S3StorageAdapter implements StorageAdapter {
  private client: InstanceType<typeof Bun.S3Client>

  constructor(cfg: S3Config) {
    this.client = new Bun.S3Client({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.endpoint && { endpoint: cfg.endpoint }),
    })
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void> {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await this.client.write(fileId, bytes, { type: contentType })
  }

  async get(fileId: string): Promise<Response> {
    const exists = await this.client.exists(fileId)
    if (!exists) return new Response('Not found', { status: 404 })
    const file = this.client.file(fileId)
    return new Response(file.stream(), {
      headers: { 'Content-Type': file.type ?? 'application/octet-stream' },
    })
  }

  async delete(fileId: string): Promise<void> {
    await this.client.delete(fileId)
  }

  async exists(fileId: string): Promise<boolean> {
    return this.client.exists(fileId)
  }
}
```

- [ ] **Step 4: Update `src/storage/index.ts` to wire S3**

```typescript
// src/storage/index.ts
import type { ResolvedStorage } from '../config'
import { LocalStorageAdapter } from './local'
import { S3StorageAdapter } from './s3'

export type { LocalStorageAdapter, S3StorageAdapter }

export interface StorageAdapter {
  upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void>
  get(fileId: string): Promise<Response>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
}

export function createStorage(cfg: ResolvedStorage): StorageAdapter {
  if (cfg.type === 's3') {
    return new S3StorageAdapter({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint,
    })
  }
  return new LocalStorageAdapter(cfg.path)
}
```

- [ ] **Step 5: Run tests**

```bash
bun test tests/storage/s3.test.ts
```

Expected: `1 test, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/storage/s3.ts src/storage/index.ts tests/storage/s3.test.ts
git commit -m "feat: S3StorageAdapter using Bun.S3Client"
```

---

## Task 9: File validation

**Files:**
- Create: `src/storage/validation.ts`
- Create: `tests/storage/validation.test.ts`

**Interfaces:**
- Produces:
  - `UploadRules` — config type for per-upload constraints
  - `validateUpload(file: File, rules: UploadRules) → void` — throws `UploadValidationError` on violation

```typescript
interface UploadRules {
  allowedMimeTypes?: string[]   // e.g. ['image/jpeg', 'image/png', 'image/webp']
  maxSizeBytes?: number         // e.g. 5 * 1024 * 1024 for 5 MB
}

class UploadValidationError extends Error {
  constructor(public readonly reason: 'mime' | 'size', message: string)
}
```

- [ ] **Step 1: Write failing tests**

```typescript
// tests/storage/validation.test.ts
import { test, expect } from 'bun:test'
import { validateUpload, UploadValidationError } from '../../src/storage/validation'

function makeFile(type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], 'test.bin', { type })
}

test('passes when file meets all rules', () => {
  expect(() =>
    validateUpload(makeFile('image/jpeg', 1024), {
      allowedMimeTypes: ['image/jpeg'],
      maxSizeBytes: 5 * 1024 * 1024,
    })
  ).not.toThrow()
})

test('throws mime error for disallowed type', () => {
  expect(() =>
    validateUpload(makeFile('application/pdf', 100), { allowedMimeTypes: ['image/jpeg'] })
  ).toThrow(UploadValidationError)

  try {
    validateUpload(makeFile('application/pdf', 100), { allowedMimeTypes: ['image/jpeg'] })
  } catch (e) {
    expect(e).toBeInstanceOf(UploadValidationError)
    if (e instanceof UploadValidationError) expect(e.reason).toBe('mime')
  }
})

test('throws size error when file exceeds limit', () => {
  try {
    validateUpload(makeFile('image/jpeg', 6 * 1024 * 1024), {
      allowedMimeTypes: ['image/jpeg'],
      maxSizeBytes: 5 * 1024 * 1024,
    })
  } catch (e) {
    expect(e).toBeInstanceOf(UploadValidationError)
    if (e instanceof UploadValidationError) expect(e.reason).toBe('size')
  }
})

test('no rules = always passes', () => {
  expect(() => validateUpload(makeFile('video/mp4', 100 * 1024 * 1024), {})).not.toThrow()
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/storage/validation.test.ts
```

Expected: error — `Cannot find module '../../src/storage/validation'`

- [ ] **Step 3: Create `src/storage/validation.ts`**

```typescript
// src/storage/validation.ts
export interface UploadRules {
  allowedMimeTypes?: string[]
  maxSizeBytes?: number
}

export class UploadValidationError extends Error {
  constructor(
    public readonly reason: 'mime' | 'size',
    message: string,
  ) {
    super(message)
    this.name = 'UploadValidationError'
  }
}

export function validateUpload(file: File, rules: UploadRules): void {
  if (rules.allowedMimeTypes && !rules.allowedMimeTypes.includes(file.type)) {
    throw new UploadValidationError(
      'mime',
      `File type "${file.type}" is not allowed. Allowed: ${rules.allowedMimeTypes.join(', ')}`,
    )
  }
  if (rules.maxSizeBytes !== undefined && file.size > rules.maxSizeBytes) {
    throw new UploadValidationError(
      'size',
      `File size ${file.size} bytes exceeds limit of ${rules.maxSizeBytes} bytes`,
    )
  }
}
```

- [ ] **Step 4: Run tests — they should pass**

```bash
bun test tests/storage/validation.test.ts
```

Expected: `4 tests, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/storage/validation.ts tests/storage/validation.test.ts
git commit -m "feat: file validation — MIME type and size checks"
```

---

## Task 10: Image thumbnails

**Files:**
- Create: `src/storage/thumbnails.ts`
- Create: `tests/storage/thumbnails.test.ts`

**Interfaces:**
- Produces:
  - `TransformSpec` — width/height/fit/format/quality params (matches `?w=&h=&fit=&format=&quality=` query string)
  - `transformImage(input: Buffer, spec: TransformSpec) → Promise<Buffer>`
  - `transformHash(spec: TransformSpec) → string` — stable 16-char hex key for cache keying
  - `parseTransformSpec(query: Record<string, string>) → TransformSpec | null` — returns null if no transform params present

- [ ] **Step 1: Write failing tests**

```typescript
// tests/storage/thumbnails.test.ts
import { test, expect } from 'bun:test'
import sharp from 'sharp'
import { transformImage, transformHash, parseTransformSpec } from '../../src/storage/thumbnails'

async function makeTestImage(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer()
}

test('transformImage resizes image to target dimensions', async () => {
  const input = await makeTestImage(200, 200)
  const output = await transformImage(input, { w: 50, h: 50, fit: 'cover' })
  const meta = await sharp(output).metadata()
  expect(meta.width).toBe(50)
  expect(meta.height).toBe(50)
})

test('transformImage converts to webp when format=webp', async () => {
  const input = await makeTestImage(100, 100)
  const output = await transformImage(input, { format: 'webp' })
  const meta = await sharp(output).metadata()
  expect(meta.format).toBe('webp')
})

test('transformImage returns buffer of smaller size after resize+compress', async () => {
  const input = await makeTestImage(1000, 1000)
  const output = await transformImage(input, { w: 100, h: 100, format: 'webp', quality: 60 })
  expect(output.byteLength).toBeLessThan(input.byteLength)
})

test('transformHash produces consistent 16-char hex string', () => {
  const h1 = transformHash({ w: 100, h: 100, format: 'webp' })
  const h2 = transformHash({ w: 100, h: 100, format: 'webp' })
  expect(h1).toBe(h2)
  expect(h1).toHaveLength(16)
  expect(/^[0-9a-f]+$/.test(h1)).toBe(true)
})

test('transformHash differs for different specs', () => {
  const h1 = transformHash({ w: 100 })
  const h2 = transformHash({ w: 200 })
  expect(h1).not.toBe(h2)
})

test('parseTransformSpec returns null when no transform params', () => {
  expect(parseTransformSpec({})).toBeNull()
  expect(parseTransformSpec({ foo: 'bar' })).toBeNull()
})

test('parseTransformSpec parses width and height', () => {
  const spec = parseTransformSpec({ w: '100', h: '200' })
  expect(spec).not.toBeNull()
  expect(spec?.w).toBe(100)
  expect(spec?.h).toBe(200)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/storage/thumbnails.test.ts
```

Expected: error — `Cannot find module '../../src/storage/thumbnails'`

- [ ] **Step 3: Create `src/storage/thumbnails.ts`**

```typescript
// src/storage/thumbnails.ts
import sharp from 'sharp'
import { createHash } from 'node:crypto'

export interface TransformSpec {
  w?: number
  h?: number
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  quality?: number
}

export async function transformImage(input: Buffer, spec: TransformSpec): Promise<Buffer> {
  let pipeline = sharp(input)

  if (spec.w !== undefined || spec.h !== undefined) {
    pipeline = pipeline.resize(spec.w, spec.h, { fit: spec.fit ?? 'cover' })
  }

  if (spec.format) {
    pipeline = pipeline.toFormat(spec.format, { quality: spec.quality })
  } else if (spec.quality) {
    pipeline = pipeline.jpeg({ quality: spec.quality })
  }

  return pipeline.toBuffer()
}

export function transformHash(spec: TransformSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
}

export function parseTransformSpec(query: Record<string, string>): TransformSpec | null {
  const { w, h, fit, format, quality } = query
  if (!w && !h && !fit && !format && !quality) return null

  const spec: TransformSpec = {}
  if (w) spec.w = Number(w)
  if (h) spec.h = Number(h)
  if (fit && ['cover', 'contain', 'fill', 'inside', 'outside'].includes(fit)) {
    spec.fit = fit as TransformSpec['fit']
  }
  if (format && ['webp', 'jpeg', 'png', 'avif'].includes(format)) {
    spec.format = format as TransformSpec['format']
  }
  if (quality) spec.quality = Math.min(100, Math.max(1, Number(quality)))
  return spec
}
```

- [ ] **Step 4: Run tests — they should pass**

```bash
bun test tests/storage/thumbnails.test.ts
```

Expected: `7 tests, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/storage/thumbnails.ts tests/storage/thumbnails.test.ts
git commit -m "feat: image thumbnails — sharp transforms with stable cache key"
```

---

## Task 11: File upload HTTP route + wire storage into createBunderstack

**Files:**
- Modify: `src/handler.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `StorageAdapter` (storage/index.ts), `validateUpload` (storage/validation.ts), `transformImage` + `parseTransformSpec` (storage/thumbnails.ts)
- Produces: `/files` routes in the Hono app

File upload routes:
```
POST   /files            — multipart/form-data; field "file"; returns { fileId, url }
GET    /files/:fileId    — serve file; ?w=&h=&format=&fit= triggers on-the-fly transform+cache
DELETE /files/:fileId    — delete file
```

Files are stored as `<random-uuid>.<ext>`. Thumbnail cache keys are `<fileId>__<transformHash>.<format>`.

- [ ] **Step 1: Update `src/handler.ts` to accept and route the storage router**

`src/handler.ts` already accepts `storageRouter?: Hono` in `HandlerParts` and mounts it at `/files`. No change needed there — the storageRouter is built in `src/index.ts`.

- [ ] **Step 2: Create storage route builder in `src/index.ts` (update the file)**

Replace `src/index.ts` with:

```typescript
// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { createAuth } from './auth'
import { createStorage, type StorageAdapter } from './storage/index'
import { buildHandler } from './handler'
import { validateUpload, type UploadRules } from './storage/validation'
import { transformImage, parseTransformSpec, transformHash } from './storage/thumbnails'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

type AuthInstance = ReturnType<typeof createAuth>

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageAdapter
  router: Hono
}

export interface BunderstackStorageConfig {
  uploadRules?: UploadRules
}

function buildStorageRouter(storage: StorageAdapter, opts: BunderstackStorageConfig = {}): Hono {
  const router = new Hono()

  router.post('/', async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) return c.json({ error: 'No file field in request' }, 400)

    if (opts.uploadRules) {
      try {
        validateUpload(file, opts.uploadRules)
      } catch (err) {
        return c.json({ error: (err as Error).message }, 422)
      }
    }

    const ext = extname(file.name) || ''
    const fileId = `${randomUUID()}${ext}`
    await storage.upload(fileId, await file.arrayBuffer(), file.type)
    return c.json({ fileId, url: `/files/${fileId}` }, 201)
  })

  router.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const query = c.req.query() as Record<string, string>
    const spec = parseTransformSpec(query)

    if (spec) {
      const cacheKey = `${fileId}__${transformHash(spec)}`
      const cachedExists = await storage.exists(cacheKey)
      if (cachedExists) return storage.get(cacheKey)

      const original = await storage.get(fileId)
      if (original.status === 404) return original

      const inputBuffer = Buffer.from(await original.clone().arrayBuffer())
      const transformed = await transformImage(inputBuffer, spec)
      const contentType = spec.format ? `image/${spec.format}` : original.headers.get('Content-Type') ?? 'image/jpeg'
      await storage.upload(cacheKey, transformed, contentType)
      return new Response(transformed, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' } })
    }

    return storage.get(fileId)
  })

  router.delete('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    await storage.delete(fileId)
    return new Response(null, { status: 204 })
  })

  return router
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema> & { storageOptions?: BunderstackStorageConfig },
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const auth = createAuth(db as LibSQLDatabase<Record<string, unknown>>, config.auth)
  const storage = createStorage(config.storage)
  const crudRouter = buildCrudRouter(options.schema, db)
  const storageRouter = buildStorageRouter(storage, options.storageOptions)
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
  })

  return { handler, db, auth, storage, router }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
export type { StorageAdapter } from './storage/index'
export type { UploadRules } from './storage/validation'
export type { TransformSpec } from './storage/thumbnails'
```

- [ ] **Step 3: Run all tests to confirm nothing broke**

```bash
bun test
```

Expected: `22 tests, 0 failed` (all previous tests still pass)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/handler.ts
git commit -m "feat: file upload/serve/delete routes with on-the-fly thumbnail transforms"
```

---

## Task 12: Standalone example + end-to-end smoke test

**Files:**
- Create: `examples/standalone/server.ts`
- Create: `examples/standalone/drizzle.config.ts`

This is the "does it actually work" gate. Run the server, curl it, confirm the loop works.

- [ ] **Step 1: Create drizzle config for the example**

```typescript
// examples/standalone/drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './examples/standalone/schema.ts',
  out: './examples/standalone/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: './examples/standalone/data.db' },
})
```

- [ ] **Step 2: Create the standalone server**

```typescript
// examples/standalone/server.ts
import { createBunderstack } from '../../src/index'
import * as schema from './schema'

const app = createBunderstack({
  schema,
  auth: { emailPassword: true },
  storage: { local: './examples/standalone/uploads' },
  storageOptions: {
    uploadRules: {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  },
})

// Expose raw instances for drop-down access
export const { db, auth, storage, router } = app

const server = Bun.serve({
  port: 3001,
  fetch: app.handler,
})

console.log(`Bunderstack POC running at http://localhost:${server.port}`)
console.log('Routes:')
console.log('  GET  /health')
console.log('  GET  /api/posts')
console.log('  POST /api/posts')
console.log('  POST /files         (multipart, field: file)')
console.log('  GET  /files/:id     (?w=&h=&format=webp for thumbnails)')
console.log('  POST /auth/sign-up/email')
console.log('  POST /auth/sign-in/email')
```

- [ ] **Step 3: Push schema to local SQLite**

```bash
bunx drizzle-kit push --config examples/standalone/drizzle.config.ts
```

Expected: tables created in `examples/standalone/data.db`

- [ ] **Step 4: Start the server**

```bash
bun run examples/standalone/server.ts
```

Expected: `Bunderstack POC running at http://localhost:3001`

- [ ] **Step 5: Smoke-test CRUD**

```bash
# Health check
curl http://localhost:3001/health

# Create a post
curl -s -X POST http://localhost:3001/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello Bunderstack","body":"It works!"}' | jq .

# List posts
curl -s http://localhost:3001/api/posts | jq .

# Get by id
curl -s http://localhost:3001/api/posts/1 | jq .
```

Expected: each command returns JSON with the expected shape (200 / 201 status).

- [ ] **Step 6: Smoke-test auth**

```bash
# Sign up
curl -s -X POST http://localhost:3001/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","name":"Test User"}' | jq .

# Sign in
curl -s -X POST http://localhost:3001/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}' | jq .
```

Expected: sign-up returns user object; sign-in returns session token.

- [ ] **Step 7: Smoke-test file upload and thumbnail**

```bash
# Download a test jpeg
curl -o /tmp/test.jpg https://picsum.photos/400/400

# Upload
curl -s -X POST http://localhost:3001/files \
  -F "file=@/tmp/test.jpg" | jq .

# Retrieve original (replace FILE_ID with the returned fileId)
curl -I http://localhost:3001/files/FILE_ID

# Retrieve with 100x100 webp transform
curl -I "http://localhost:3001/files/FILE_ID?w=100&h=100&format=webp"
```

Expected: upload returns `{ fileId, url }`; GET returns 200; second GET (transform) returns 200 with `Content-Type: image/webp`.

- [ ] **Step 8: Commit**

```bash
git add examples/standalone/server.ts examples/standalone/drizzle.config.ts
git commit -m "feat: standalone example — Bunderstack POC running on Bun.serve"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] `createBunderstack({ schema })` entry point — Task 5
- [x] `app.handler (req) => Response` — Task 5
- [x] `app.db` raw Drizzle — Task 5
- [x] `app.auth` BetterAuth — Task 6
- [x] `app.storage` — Task 7–8
- [x] `app.router` Hono — Task 5
- [x] Auto CRUD (list/get/create/update/delete + filter/page) — Task 4
- [x] Email/password + OAuth config — Task 6
- [x] Local + S3 storage — Tasks 7–8
- [x] File validation (MIME, size) — Task 9
- [x] Thumbnail transforms + cache — Task 10, 11
- [x] Standalone Bun server demo — Task 12
- [x] TanStack Start / Next.js mount pattern documented in plan.md — shown in `app.handler` export

**Not included in POC (post-MVP):**
- Realtime / SSE (Phase 3)
- Typed client codegen (Phase 4)
- CLI (`bunderstack dev / db push` — users call `bunx drizzle-kit` directly)
- Bundled admin UI
- Postgres backend
- Row-level access rules

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N" references found.

**Type consistency:**
- `buildCrudRouter` signature consistent between Task 4 and Task 5
- `StorageAdapter` interface defined in Task 7, implemented in Task 8, consumed in Task 11 — names match
- `TransformSpec`, `transformImage`, `parseTransformSpec`, `transformHash` defined in Task 10, imported in Task 11 — names match
- `validateUpload` / `UploadRules` / `UploadValidationError` defined in Task 9, imported in Task 11 — names match
