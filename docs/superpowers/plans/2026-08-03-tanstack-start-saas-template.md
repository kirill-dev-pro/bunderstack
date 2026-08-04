# TanStack Start SaaS Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished, runnable TanStack Start SaaS template demonstrating Bunderstack CRUD, auth, realtime, storage, jobs, email, env, landing, user dashboard, and admin dashboard.

**Architecture:** Add the template as a workspace package at `templates/tanstack-start-saas`. Use a modular Bunderstack entry, a separate queue worker, TanStack Start catch-all API routing, and a typed Bunderstack client. Keep the UI product-specific enough to be coherent while making naming easy to replace.

**Tech Stack:** Bun, TypeScript, React 19, TanStack Start, Bunderstack workspace packages, Better Auth, Drizzle/libSQL, Tailwind CSS 4, shadcn/ui conventions, Bun test.

## Global Constraints

- Product subject: **Relay**, a project-delivery workspace for small creative studios.
- Domain: users, projects, tasks, and project attachments.
- Use `createApiHandlers(app)` and `bunderstackStart<App>()`.
- Use `libsql()` explicitly and export all required Bunderstack/auth schema tables.
- Use a separate `src/worker.ts` with `app.runWorker()`.
- Use Bun commands only.
- Do not commit databases, uploads, secrets, build output, or generated route trees.

## Visual direction

- **Ink** `#17211B`: primary text and navigation.
- **Parchment** `#F6F3E9`: page ground.
- **Mint sheet** `#DCEBDD`: panels and selected states.
- **Signal blue** `#315CF5`: actions and focus.
- **Amber pin** `#E9A23B`: deadlines and attention.
- **Paper white** `#FFFDF7`: cards.
- Display: Newsreader. Body: DM Sans. Utility/data: IBM Plex Mono.
- Signature: a vertical **delivery rail** connecting project milestones and task
  states. It is a real status control, not decoration.

```text
Landing
┌──────────────────────────────────────────────────────────────┐
│ Relay      Product  Workflow                       Sign in   │
├───────────────────────────────┬──────────────────────────────┤
│ Deliver the work,             │ LIVE DELIVERY RAIL           │
│ not the status meeting.       │ ● Brief received             │
│ [Start a workspace]           │ │                             │
│                               │ ● In production               │
│ client proof / team rhythm    │ │                             │
│                               │ ○ Ready to send               │
└───────────────────────────────┴──────────────────────────────┘

Dashboard
┌────────────┬─────────────────────────────────────────────────┐
│ Relay      │ Today / project pulse / create project          │
│ Overview   ├───────────────────────┬─────────────────────────┤
│ Projects   │ Active projects       │ Delivery rail           │
│ Files      │ task progress cards   │ recent state changes    │
│ Admin*     │                       │                         │
└────────────┴───────────────────────┴─────────────────────────┘
```

---

### Task 1: Workspace and template contract

**Files:**
- Modify: `package.json`
- Create: `scripts/template-contract.test.ts`
- Create: `templates/tanstack-start-saas/package.json`
- Create: `templates/tanstack-start-saas/tsconfig.json`
- Create: `templates/tanstack-start-saas/vite.config.ts`
- Create: `templates/tanstack-start-saas/components.json`
- Create: `templates/tanstack-start-saas/.gitignore`
- Create: `templates/tanstack-start-saas/.env.example`

**Interfaces:**
- Consumes: root Bun workspace and published-package boundaries.
- Produces: a named workspace package and executable template scripts.

- [ ] **Step 1: Write the failing structural test**

```ts
import { expect, test } from 'bun:test'
import templatePackage from '../templates/tanstack-start-saas/package.json'

test('SaaS template exposes the Bunderstack deployment contract', () => {
  expect(templatePackage.bunderstack.entry).toBe('src/bunderstack/index.ts')
  expect(templatePackage.scripts).toMatchObject({
    dev: 'bun --bun vite dev',
    worker: 'bun src/worker.ts',
    typecheck: 'tsc --noEmit',
    blueprint: 'bun ../../packages/bunderstack/src/cli.ts blueprint',
    'blueprint:check': 'bun ../../packages/bunderstack/src/cli.ts blueprint --check',
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `bun test scripts/template-contract.test.ts`

Expected: FAIL because the template package does not exist.

- [ ] **Step 3: Add `templates/*` to the root workspaces and create package metadata**

Use current workspace package versions and exact TanStack versions already used
by `examples/tldraw`. Include React, Better Auth, Drizzle, Zod, Tailwind,
Radix slot/dialog/dropdown, Lucide, `class-variance-authority`, `clsx`, and
`tailwind-merge`. Configure `ssr.noExternal: [/^bunderstack/]`.

- [ ] **Step 4: Run install and structural GREEN**

```bash
bun install
bun test scripts/template-contract.test.ts
```

- [ ] **Step 5: Commit workspace scaffold**

```bash
git add package.json bun.lock scripts/template-contract.test.ts templates/tanstack-start-saas
git commit -m "feat: scaffold TanStack Start SaaS template"
```

---

### Task 2: Bunderstack schema, access, auth, and runtime

**Files:**
- Create: `templates/tanstack-start-saas/src/bunderstack/schema/auth.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/schema/projects.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/schema/index.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/access.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/env.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/auth.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/jobs.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/trpc.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/index.ts`
- Create: `templates/tanstack-start-saas/src/worker.ts`
- Create: `templates/tanstack-start-saas/src/bunderstack/app.test.ts`
- Create: `templates/tanstack-start-saas/drizzle.config.ts`

**Interfaces:**
- Produces: `createRelayApp({ databaseUrl? })`, `app`, `App`, owner-scoped resources, `admin.overview`, `projects.create`, `tasks.complete`, `sendProjectDigest`, and `archiveCompletedTasks`.

- [ ] **Step 1: Write failing handler and manifest tests**

```ts
import { afterEach, expect, test } from 'bun:test'
import { provision } from 'bunderstack/provision'
import { mockAuthSession } from 'bunderstack/testing'
import { createRelayApp } from './index'

const apps: Awaited<ReturnType<typeof createRelayApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

test('declares the full SaaS runtime', async () => {
  const app = await createRelayApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  expect(app.manifest.realtime.required).toBe(true)
  expect(app.manifest.background.jobs).toEqual([{ name: 'sendProjectDigest' }])
  expect(app.manifest.background.cron).toEqual([
    { name: 'archiveCompletedTasks', schedule: '0 3 * * *', timezone: 'UTC' },
  ])
})

test('does not expose projects without a session', async () => {
  const app = await createRelayApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  await provision(app, { force: true })
  const response = await app.handler(new Request('http://relay.test/api/projects'))
  expect(response.status).toBe(401)
})
```

- [ ] **Step 2: Verify RED**

Run: `bun test --cwd templates/tanstack-start-saas src/bunderstack/app.test.ts`

Expected: FAIL because `createRelayApp` does not exist.

- [ ] **Step 3: Implement schema and access**

Use TypeID primary keys. `projects` has `id`, `ownerId`, `name`, `clientName`,
`status`, `dueAt`, `createdAt`, and `updatedAt`. `tasks` has `id`, `projectId`,
`ownerId`, `title`, `status`, `position`, `completedAt`, `createdAt`, and
`updatedAt`. Both list endpoints require authentication and scope on `ownerId`.
Writes expose only user-controlled columns; owner IDs are stamped server-side.

- [ ] **Step 4: Implement app construction and background work**

```ts
export async function createRelayApp(options: { databaseUrl?: string } = {}) {
  return createBunderstack({
    schema,
    access,
    env: envSchema,
    database: { adapter: libsql(), url: options.databaseUrl ?? process.env.DATABASE_URL ?? 'file:./data.db' },
    auth: authConfig,
    email: { from: 'Relay <hello@example.com>' },
    storage: { local: './uploads', defaultBucket: 'project-files', buckets: {
      'project-files': { visibility: 'private', access: { create: 'authenticated', get: 'owner', delete: 'owner' }, upload: { maxSize: '10mb' } },
    } },
    realtime: process.env.REDIS_URL ? { redis: process.env.REDIS_URL } : true,
    jobs: defineJobs,
    trpc: createAppRouter,
  })
}
```

Export `app`, call `await provision(app)`, and put only `await app.runWorker()`
in `src/worker.ts`.

- [ ] **Step 5: Implement protected and admin tRPC procedures**

Create project/task mutations with Zod inputs. Direct Drizzle writes call
`ctx.realtime.publish(schema.tasks, 'update', updatedTask)` after returning the
full row. `admin.overview` throws `TRPCError({ code: 'FORBIDDEN' })` unless
`ctx.user.role === 'admin'`.

- [ ] **Step 6: Run backend tests and typecheck**

```bash
bun test --cwd templates/tanstack-start-saas src/bunderstack/app.test.ts
bun run --cwd templates/tanstack-start-saas typecheck
```

- [ ] **Step 7: Commit the backend runtime**

```bash
git add templates/tanstack-start-saas/src/bunderstack templates/tanstack-start-saas/src/worker.ts templates/tanstack-start-saas/drizzle.config.ts
git commit -m "feat: add Relay Bunderstack runtime"
```

---

### Task 3: TanStack integration and auth flow

**Files:**
- Create: `templates/tanstack-start-saas/src/routes/api/$.tsx`
- Create: `templates/tanstack-start-saas/src/api.ts`
- Create: `templates/tanstack-start-saas/src/router.tsx`
- Create: `templates/tanstack-start-saas/src/routes/__root.tsx`
- Create: `templates/tanstack-start-saas/src/routes/login.tsx`
- Create: `templates/tanstack-start-saas/src/routes/register.tsx`
- Create: `templates/tanstack-start-saas/src/lib/auth-client.ts`
- Create: `templates/tanstack-start-saas/src/lib/session.ts`
- Create: `templates/tanstack-start-saas/src/integration-contract.test.ts`

**Interfaces:**
- Consumes: `App`, `app.auth`, and `app.handler`.
- Produces: catch-all API handlers, typed sync client, SSR session helpers, login and registration routes.

- [ ] **Step 1: Write the failing integration contract**

Read the route and client modules as text and assert they contain
`createApiHandlers(app)`, `bunderstackStart<App>()`, and imports from
`bunderstack-start/auth`.

- [ ] **Step 2: Verify RED**

Run: `bun test --cwd templates/tanstack-start-saas src/integration-contract.test.ts`

- [ ] **Step 3: Implement API mount and typed client**

```ts
export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})

export const { createQueryClient, createApi } = bunderstackStart<App>()
```

Create auth client through the published Start auth subpath. Use root route
context to pass query client, API, and session state without importing server
modules into client bundles.

- [ ] **Step 4: Implement accessible auth screens**

Use explicit labels, autocomplete attributes, visible focus states, disabled
pending buttons, and server error text. Successful registration redirects to
`/app`; sign-in keeps the same action vocabulary from button to notification.

- [ ] **Step 5: Run contract and type tests**

```bash
bun test --cwd templates/tanstack-start-saas src/integration-contract.test.ts
bun run --cwd templates/tanstack-start-saas typecheck
```

- [ ] **Step 6: Commit integration and auth**

```bash
git add templates/tanstack-start-saas/src
git commit -m "feat: wire Relay auth and TanStack API"
```

---

### Task 4: Design system, landing, and dashboards

**Files:**
- Create: `templates/tanstack-start-saas/src/styles.css`
- Create: `templates/tanstack-start-saas/src/components/ui/button.tsx`
- Create: `templates/tanstack-start-saas/src/components/ui/card.tsx`
- Create: `templates/tanstack-start-saas/src/components/ui/input.tsx`
- Create: `templates/tanstack-start-saas/src/components/ui/badge.tsx`
- Create: `templates/tanstack-start-saas/src/components/app-shell.tsx`
- Create: `templates/tanstack-start-saas/src/components/delivery-rail.tsx`
- Create: `templates/tanstack-start-saas/src/routes/index.tsx`
- Create: `templates/tanstack-start-saas/src/routes/app.tsx`
- Create: `templates/tanstack-start-saas/src/routes/app/index.tsx`
- Create: `templates/tanstack-start-saas/src/routes/app/projects.tsx`
- Create: `templates/tanstack-start-saas/src/routes/app/projects.$projectId.tsx`
- Create: `templates/tanstack-start-saas/src/routes/app/admin.tsx`

**Interfaces:**
- Consumes: typed `api.projects`, `api.tasks`, file bucket, tRPC queries, and auth session.
- Produces: responsive landing, user project workflow, attachment upload, realtime task state, and role-gated admin overview.

- [ ] **Step 1: Implement tokens and reusable shadcn-style primitives**

Define CSS variables from the approved palette, the three font roles, 10px card
radius, 2px focus ring, reduced-motion fallbacks, and responsive shell widths.
Use `cn()` with `clsx` and `tailwind-merge`.

- [ ] **Step 2: Implement the landing thesis**

The hero headline is “Deliver the work, not the status meeting.” The right side
is a functional-looking delivery rail showing Brief received, In production,
Client review, and Ready to send. Avoid generic metric cards and gradients.

- [ ] **Step 3: Implement user dashboard flows**

Create projects, list owner-scoped projects, open a project, add/complete tasks,
and upload attachments. Empty states use direct actions: “Create your first
project” and “Add the next deliverable.”

- [ ] **Step 4: Implement admin overview**

Route loading checks the session role and redirects non-admin users. Data still
comes from the server-authorized `admin.overview` procedure. Display user,
project, open-task, and recent-delivery data using compact tables and the same
delivery vocabulary.

- [ ] **Step 5: Typecheck and build**

```bash
bun run --cwd templates/tanstack-start-saas typecheck
bun run --cwd templates/tanstack-start-saas build
```

- [ ] **Step 6: Commit UI**

```bash
git add templates/tanstack-start-saas/src
git commit -m "feat: add Relay landing and dashboards"
```

---

### Task 5: Deployment, documentation, and visual QA

**Files:**
- Create: `templates/tanstack-start-saas/README.md`
- Generate: `templates/tanstack-start-saas/bunderstack.blueprint.yaml`
- Modify: `scripts/template-contract.test.ts`

**Interfaces:**
- Produces: copy instructions, environment reference, migration flow, admin bootstrap instructions, and verified deployment blueprint.

- [ ] **Step 1: Extend contract tests**

Assert the API route, modular entry, worker, `.env.example`, README, blueprint,
landing, user dashboard, and admin dashboard all exist. Assert README uses
`bun install`, `bun run dev`, `bun run db:generate`, and
`bun run blueprint:check`.

- [ ] **Step 2: Generate and check blueprint**

```bash
bun run --cwd templates/tanstack-start-saas blueprint
bun run --cwd templates/tanstack-start-saas blueprint:check
```

- [ ] **Step 3: Run the application and inspect responsive UI**

Run `bun run --cwd templates/tanstack-start-saas dev`, capture landing, login,
user dashboard, project detail, and admin dashboard at desktop and mobile
widths. Verify keyboard focus and reduced motion. Fix clipping, contrast,
hierarchy, empty states, and any generic decorative element.

- [ ] **Step 4: Run template and repository verification**

```bash
bun test scripts/template-contract.test.ts
bun test --cwd templates/tanstack-start-saas
bun run --cwd templates/tanstack-start-saas typecheck
bun run --cwd templates/tanstack-start-saas build
bun run test
```

- [ ] **Step 5: Commit verified template**

```bash
git add templates/tanstack-start-saas scripts/template-contract.test.ts package.json bun.lock
git commit -m "docs: finish verified Bunderstack SaaS template"
```
