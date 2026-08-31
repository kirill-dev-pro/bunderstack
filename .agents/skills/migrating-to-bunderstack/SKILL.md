---
name: migrating-to-bunderstack
description: Use when building, structuring, or migrating an application on Bunderstack, configuring Drizzle schemas, Better Auth, oRPC procedures, access rules, storage, background jobs, realtime, or preparing deployments for Bunderhost.
---

# Bunderstack Architecture & Migration Guide

## Overview

Bunderstack is a batteries-included full-stack backend framework for Bun unifying:
- **Drizzle ORM** (libSQL / SQLite / Postgres)
- **Better Auth** (authentication & session management)
- **oRPC v2** (unified type-safe RPC & OpenAPI/REST procedures with Standard Schema / Valibot)
- **Storage** (S3 / local disk buckets with transforms via Bun.Image)
- **Background Jobs & Cron** (durable queue, schedule execution, retry handling)
- **Realtime** (SSE streaming with heartbeat recovery & optimistic correlation)
- **Email** (Resend / SMTP / Console)

---

## 1. Core Architectural Model

### Declaration vs. Runtime Separation

Bunderstack separates the static application declaration from the running instance:

```ts
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import { schema } from './schema'
import { access } from './access'
import { api } from './api'

// 1. Pure synchronous declaration (does NO I/O, no DB connection, exports static manifest)
export const backend = bunderstack({
  schema,
  access,
  database: { adapter: libsql(), url: process.env.DATABASE_URL ?? 'file:./data.db' },
  api,
})

// 2. Explicit runtime start (connects to DB, migrates, starts services)
export const app = await backend.start()
export type App = typeof app
```

- `backend.manifest` can be read statically by tools (such as blueprint generators) without starting the app or connecting to a database.
- `app = await backend.start()` explicitly boots the runtime.
- `backend.test()` creates an isolated, lexically owned test fixture.

### Single Package & Flat Subpath Exports

All Bunderstack capabilities are imported directly from single-segment subpaths of `bunderstack`:

| Subpath Import | Purpose |
| --- | --- |
| `bunderstack` | Core backend builder (`bunderstack`, `defineApi`, `defineAccess`, `BunderstackError`) |
| `bunderstack/libsql` | libSQL / SQLite database adapter |
| `bunderstack/postgres-js` | postgres.js database adapter |
| `bunderstack/bun-sql` | `Bun.sql` Postgres adapter |
| `bunderstack/pglite` | PGlite in-memory / embedded Postgres adapter |
| `bunderstack/client` | Framework-neutral typed client & `createLiveView` |
| `bunderstack/client-react` | React LiveView hook (`useLiveView`) |
| `bunderstack/client-rest` | Type-safe REST client |
| `bunderstack/query` | TanStack Query integration (`createClient`, `syncRealtime`) |
| `bunderstack/query-react` | React-specific query helpers |
| `bunderstack/sync` | TanStack DB realtime sync collections |
| `bunderstack/start` | TanStack Start integration (`createApiHandlers`) |
| `bunderstack/start-auth` | Better Auth client for TanStack Start |
| `bunderstack/provision` | Database schema provisioning (`provision(app)`) |
| `bunderstack/testing` | Test fixture helpers |
| `bunderstack/schema` | Internal system tables (`export * from 'bunderstack/schema'`) |
| `bunderstack/typeid` | TypeID column types & generators |

---

## 2. Project Structuring & Best Practices

### Scale Decision: Flat vs. Modular

1. **Flat Layout (MVP / Small Service: < 5 tables, < 5 procedures, 1 job):**
   ```
   src/
   ├── bunderstack.ts   # backend declaration & app start
   ├── schema.ts        # Drizzle schema
   ├── access.ts        # defineAccess rules
   ├── api.ts           # defineApi and procedures
   ├── env.ts           # Valibot envSchema
   └── worker.ts        # app.runWorker() entry
   ```

2. **Modular Layout (Production SaaS / Multi-Domain, HR Breakers pattern):**
   Consolidate all backend logic in `src/bunderstack/` with domain separation:
   ```
   src/bunderstack/
   ├── backend.ts         # Synchronous bunderstack({...}) declaration
   ├── index.ts           # export const app = await backend.start(), provision(app), exports { db, auth, env }
   ├── env.ts             # envSchema (server / client) via Valibot
   ├── access.ts          # defineAccess(schema, { ... })
   ├── auth.ts            # authConfig for Better Auth
   ├── schema/            # Segmented Drizzle tables
   │   ├── auth.ts        # Better Auth tables
   │   ├── billing.ts     # Billing / subscription tables
   │   ├── core.ts        # Domain entities
   │   └── index.ts       # Aggregates schemas + export * from 'bunderstack/schema'
   ├── api/               # oRPC Procedure Graph
   │   ├── base.ts        # defineApi({ schema, env }), bases (public, protected, admin), middleware
   │   ├── billing.ts     # Billing domain router (plain object)
   │   ├── users.ts       # Users domain router
   │   ├── admin.ts       # Admin router
   │   └── index.ts       # export const api = { billing, users, admin }
   ├── jobs/              # Background Jobs & Cron
   │   ├── generate-pdf.ts# Heavy job handler + onFailed
   │   ├── cleanup.ts     # jobs.cron() handler
   │   └── index.ts       # jobs.define({ ... })
   ├── methods.ts         # (or services/) Pure domain database operations and business logic
   └── types.ts           # Database type aliases ($inferSelect, $inferInsert)
   ```

### Rule: Thin Routers vs. Service Layer (`methods.ts`)

Keep API procedures thin. Routers only validate input, authorize, and delegate heavy logic to service functions:

```ts
// src/bunderstack/api/resumes.ts
import * as v from 'valibot'
import { protectedProcedure } from './base'
import { generateResumeForUser } from '../methods'

export const resumesRouter = {
  generate: protectedProcedure
    .input(v.object({ templateId: v.string() }))
    .output(v.object({ jobId: v.string() }))
    .handler(async ({ context, input }) => {
      // Delegate to service function in methods.ts
      const jobId = await generateResumeForUser(context, input.templateId)
      return { jobId }
    }),
}
```

### Rule: Module-Scoped API Builder (`api/base.ts`)

Declare `defineApi` once at module scope. Router files import procedure bases directly without needing factory functions:

```ts
// src/bunderstack/api/base.ts
import { defineApi } from 'bunderstack'
import { envSchema } from '../env'
import { schema } from '../schema'
import { eq } from 'drizzle-orm'

export const o = defineApi({ schema, env: envSchema })

export const publicProcedure = o.public

export const protectedProcedure = o.protected.use(async ({ context, next }) => {
  // context.user is guaranteed non-null in o.protected
  return next()
})

export const adminProcedure = protectedProcedure.use(async ({ context, next, errors }) => {
  if (context.user.role !== 'admin') {
    throw errors.FORBIDDEN({ message: 'Admin privileges required' })
  }
  return next()
})

// Graph-wide observability middleware (registered in bunderstack({ middleware: [instrumentation] }))
export const instrumentation = o.middleware(async ({ context, next, path }) => {
  const startedAt = performance.now()
  try {
    const result = await next()
    return result
  } finally {
    const duration = Math.round(performance.now() - startedAt)
    // context.peekSession() reads resolved session without triggering forced auth on public/webhooks
    const userId = context.peekSession()?.user?.id
    console.log(`[oRPC] ${path.join('.')} - ${duration}ms - User: ${userId ?? 'anon'}`)
  }
})
```

### Rule: Circular Boot-Time Import Prevention

`src/bunderstack/auth.ts` and `api/base.ts` must **NEVER** import `app` or `src/bunderstack/index.ts` at module top-level.
- In `auth.ts`: Read `process.env` directly for secret keys. If an async hook (like email sending) needs the initialized app, use dynamic `import('./index')` inside the callback.
- In `api/*.ts`: Consume `context.db`, `context.env`, `context.jobs`, `context.storage`, `context.auth` from handler parameters.

---

## 3. Subsystem Architecture

### 3.1 Declarative Access Control & Generated CRUD

`defineAccess` automatically exposes REST & RPC CRUD procedures for tables (`list`, `get`, `create`, `update`, `delete`):

```ts
// src/bunderstack/access.ts
import { defineAccess } from 'bunderstack'
import { schema } from './schema'

export const access = defineAccess(schema, {
  posts: {
    list: 'public',
    get: 'public',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    ownerColumn: 'authorId', // defaults to userId if present
    filterableColumns: ['authorId', 'category', 'isPublished'],
    sortableColumns: ['createdAt', 'title'],
    defaultSort: { column: 'createdAt', order: 'desc' },
    scope: {
      read: (ctx) => ({ isPublished: true }), // applied to public queries
    },
  },
  // Hide internal or sensitive tables from public CRUD endpoints
  auditLogs: { crud: false },
  systemSettings: { crud: false },
})
```

- **Querying CRUD over RPC**:
  ```ts
  await client.posts.list.call({
    filters: { authorId: 'user_123' },
    sort: 'createdAt',
    order: 'desc',
    limit: 20,
  })
  ```
- **CRUD Updates**: Accept `{ id, ...changes }` directly:
  ```ts
  await client.posts.update.call({ id: 'post_1', title: 'Updated Title' })
  ```
- **Custom List Procedures**: Use `listSpec` to give custom endpoints the same pagination and filtering behavior:
  ```ts
  import { listSpec } from 'bunderstack'
  
  const logSpec = listSpec(schema.auditLogs, {
    filterable: ['level', 'userId'],
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  })
  
  export const logsProcedure = adminProcedure
    .input(logSpec.input)
    .handler(logSpec.handler)
  ```

### 3.2 Authentication (`authConfig`)

Export a clean Better Auth config and pass it into `bunderstack({ auth: authConfig })`:

```ts
// src/bunderstack/auth.ts
import type { BetterAuthConfig } from 'better-auth'

export const authConfig = {
  secret: process.env.AUTH_SECRET ?? 'dev-secret-at-least-32-chars-long',
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 7 }, // 7 days
} satisfies BetterAuthConfig
```

In `schema/index.ts`, ensure all Better Auth tables (`user`, `session`, `account`, `verification`) are aggregated so Drizzle migrations generate them.

### 3.3 Background Jobs & Scheduled Cron

Jobs and cron are declared inside `jobs.define`:

```ts
// src/bunderstack/jobs/index.ts
import * as v from 'valibot'

export const defineJobs = (jobs) =>
  jobs.define({
    sendWelcomeEmail: jobs.job({
      input: v.object({ userId: v.string(), email: v.pipe(v.string(), v.email()) }),
      concurrency: 5,
      timeout: 30_000,
      retries: 3,
      handler: async ({ userId, email }, ctx) => {
        await ctx.email.send({
          to: email,
          subject: 'Welcome!',
          html: '<h1>Welcome to our service</h1>',
        })
      },
      onFailed: async ({ userId }, error, ctx) => {
        console.error(`Failed to send welcome email to user ${userId}`, error)
      },
    }),
    hourlyCleanup: jobs.cron({
      schedule: '0 * * * *', // Five-field UTC cron
      handler: async (_invocation, ctx) => {
        // ctx.db, ctx.env available
      },
    }),
  })
```

- Enqueue from any handler or service: `await app.jobs.enqueue('sendWelcomeEmail', { userId: '1', email: 'user@example.com' })`
- Cron runs are automatically registered in the deployment blueprint.

### 3.4 Storage

Declare buckets with access control and file restrictions:

```ts
storage: {
  local: './uploads',
  defaultBucket: 'files',
  buckets: {
    avatars: {
      visibility: 'public',
      access: { create: 'authenticated', get: 'public', delete: 'owner' },
      upload: { maxSize: '5mb', accept: ['image/png', 'image/jpeg', 'image/webp'] },
      transforms: true, // enables on-the-fly resizing via Bun.Image
    },
    documents: {
      visibility: 'private',
      access: { create: 'authenticated', get: 'owner', delete: 'owner' },
    },
  },
}
```

- Uploading on server: `await app.storage.upload(key, fileBuffer, 'image/png', { bucket: 'avatars' })`
- Generating signed URL: `const url = await app.storage.getUrl(key, { expiresIn: 3600, bucket: 'documents' })`

### 3.5 Realtime Publishing

- Generated CRUD publishes updates automatically.
- For custom database writes, publish the **complete returned row** after the transaction commits:

```ts
const [row] = await ctx.db
  .update(schema.tasks)
  .set({ status: 'completed' })
  .where(eq(schema.tasks.id, input.taskId))
  .returning()

// Publish full row with schema table reference
await ctx.realtime.publish(schema.tasks, 'update', row)
```

### 3.6 Typed Errors

Raise typed errors in procedures using `errors`:

```ts
.handler(async ({ context, input, errors }) => {
  const item = await findItem(context.db, input.id)
  if (!item) throw errors.NOT_FOUND({ message: 'Item not found' })
  if (item.locked) throw errors.CONFLICT({ message: 'Item is currently locked' })
  return item
})
```

Outside procedures (e.g. in background jobs or domain services):
```ts
import { BunderstackError } from 'bunderstack'

throw new BunderstackError('FORBIDDEN', 'Quota exceeded')
```

---

## 4. Database Lifecycle & Strict Migration Rules

### Development vs. Production Lifecycle

1. **Local Development (No Migrations Folder):**
   - In dev, `await provision(app)` automatically pushes the schema to the SQLite/libSQL/Postgres database.
   - Developers can rapidly prototype and iterate on table schemas without generating migrations on every change.

2. **Production & Bunderhost Deployments (MANDATORY Migrations):**
   - **Committed migrations are strictly mandatory for production deployments.**
   - Bunderhost will **NOT** run schema push in production; deployment will fail if committed migrations in `migrations/` are missing or out of date.

### CRITICAL MIGRATION RULES

> [!CAUTION]
> **ALL MIGRATIONS MUST BE GENERATED EXCLUSIVELY VIA DRIZZLE-KIT CLI.**
> - Always run: `bunx drizzle-kit generate` (or `bun run db:generate`).
> - **NEVER** hand-edit generated migration SQL files.
> - **NEVER** let an LLM agent write or modify `.sql` files in `migrations/`.
> - Always commit both the schema changes in `src/bunderstack/schema/` and the newly generated files in `migrations/` together.

---

## 5. Web Handler & Dedicated Worker Process

### TanStack Start Catch-All (`src/routes/api/$.ts`)

Delegate all `/api/*` traffic (Better Auth, oRPC RPC, generated CRUD, Storage, Realtime) to a single catch-all handler:

```ts
// src/routes/api/$.ts
import { createFileRoute } from '@tanstack/react-router'
import { createApiHandlers } from 'bunderstack/start'
import { app } from '../../bunderstack'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: createApiHandlers(app),
  },
})
```

*Note: Remove any separate `/api/auth/$`, `/api/trpc/$`, or `/api/cron/*` route files.*

### Dedicated Production Worker (`src/worker.ts`)

In production, run background jobs in a dedicated worker process:

```ts
// src/worker.ts
import { backend } from './bunderstack/backend'

const app = await backend.start({
  env: { ...process.env, BUNDERSTACK_ROLE: 'worker' },
})

console.log('Bunderstack background worker started.')
await app.runWorker()
```

Add worker script in `package.json`:
```json
{
  "scripts": {
    "dev": "bun --bun vite dev",
    "build": "vite build",
    "start": "bun dist/server/server.js",
    "worker": "bun src/worker.ts",
    "db:generate": "drizzle-kit generate",
    "blueprint": "bunderstack blueprint",
    "blueprint:check": "bunderstack blueprint --check"
  }
}
```

---

## 6. Testing with Lexical Fixtures

Use `backend.test()` to create isolated, disposable test fixtures with in-memory DB, mocked auth, and deterministic job queues:

```ts
// src/bunderstack/api/posts.test.ts
import { test, expect } from 'bun:test'
import { backend } from '../backend'

test('creates and retrieves a post', async () => {
  // Fixture is automatically disposed at the end of scope
  await using t = await backend.test({
    database: { schema: 'push' },
  })

  // Create mock authenticated session
  const identity = t.auth.mockSession({
    id: 'user_1',
    email: 'author@example.com',
    name: 'Author Name',
  })

  // Typed in-process oRPC client
  const client = t.client(identity)

  const created = await client.posts.create({ title: 'New Post', content: 'Hello' })
  expect(created.title).toBe('New Post')

  // Run all queued background jobs deterministically
  await t.jobs.runUntilIdle()

  // Inspect sent emails
  expect(t.email.sent).toHaveLength(0)
})
```

---

## 7. Bunderhost Deployment Contract

### The Blueprint (`bunderstack.blueprint.yaml`)

Bunderhost reads `bunderstack.blueprint.yaml` at the root of the repository to provision infrastructure (databases, buckets, background workers, cron schedules, environment variables).

1. Declare the Bunderstack entry point in `package.json`:
   ```json
   {
     "bunderstack": {
       "entry": "src/bunderstack/backend.ts"
     }
   }
   ```
2. Generate and verify the blueprint:
   ```bash
   bunx bunderstack blueprint
   bunx bunderstack blueprint --check
   ```
3. Commit `bunderstack.blueprint.yaml` to git.

### Readiness Endpoint (`/api/readiness`)

Bunderhost monitors application deployment status via `GET /api/readiness`, which checks database connectivity, applied migrations, and queue backlog.

---

## 8. LLM Documentation & Bunderhost MCP Integration

### Official Bunderstack Documentation for LLMs

When working on Bunderstack projects, consult the dedicated LLM references:
- **Web Documentation**: [https://bunderstack.kcrz.dev/docs](https://bunderstack.kcrz.dev/docs)
- **Compact LLM Context (`llms.txt`)**: [https://bunderstack.kcrz.dev/docs/llms.txt](https://bunderstack.kcrz.dev/docs/llms.txt) (or local `node_modules/bunderstack/llms.txt`)
- **Complete LLM Knowledge Base (`llms-full.txt`)**: [https://bunderstack.kcrz.dev/docs/llms-full.txt](https://bunderstack.kcrz.dev/docs/llms-full.txt)

### Bunderhost MCP Server Integration

Bunderhost provides a Model Context Protocol (MCP) server that allows coding agents to inspect, manage, and deploy projects.

#### Connecting to Bunderhost MCP:
1. Generate an Agent Access Token in Bunderhost: **Organization → Agent Access → Issue Token**.
2. Connect your MCP client to `https://<bunderhost-host>/mcp` using the token as a `Bearer` credential.

#### Key MCP Tools:
- `list_projects`: List all projects in the organization.
- `get_project`: Retrieve project configuration, active deployments, and blueprint status.
- `get_project_readiness`: Check database reachability, migration state, and queue backlog.
- `create_setup_session`: Open a secure setup session for the user to configure sensitive environment variables in the dashboard.
- `deploy_project` / `deploy_revision`: Trigger a deployment (requires user confirmation).
- `get_deployment_logs`: Fetch build and deploy logs.
- `get_runtime_logs`: Stream runtime container logs.

#### Agent Safety Rules for Bunderhost:
1. **Secrets Are Never Exposed**: Database passwords, encryption keys, and environment values are never returned by MCP tools. When a new secret is needed, the agent must create a setup session (`create_setup_session`), and the user types the secret in the Bunderhost UI.
2. **Mutations Require Confirmation**: Creating projects or deploying revisions require explicit user approval in the MCP client before execution.

---

## 9. Quick Reference & Common Mistakes

| Anti-Pattern (Don't Do This) | Canonical Pattern (Do This) |
| --- | --- |
| Creating separate `/api/auth/$` and `/api/trpc/$` routes | Single catch-all `src/routes/api/$.ts` with `createApiHandlers(app)` |
| Creating multiple Drizzle instances in `src/lib/db.ts` | Use `app.db` and `context.db`; export types with `BunderstackDb<typeof schema>` |
| Constructing `ORPCError` manually | Use `errors.CODE({ message })` or `new BunderstackError('CODE', message)` |
| Calling `getSession()` inside global middleware | Use `context.peekSession()` for non-blocking observability |
| Editing `.sql` files in `migrations/` by hand | Always generate with `bunx drizzle-kit generate` and commit untouched |
| Deploying to Bunderhost with schema push only | Generate and commit Drizzle migrations before deploying |
| Starting workers inside the web server process in prod | Run dedicated `src/worker.ts` with `app.runWorker()` |
| Hand-written HTTP `/api/cron/*` endpoints | Use `jobs.cron({ schedule, handler })` |
| Top-level import of `app` inside `auth.ts` or `api/base.ts` | Consume `context` in handlers or use dynamic `import('./index')` in callbacks |

