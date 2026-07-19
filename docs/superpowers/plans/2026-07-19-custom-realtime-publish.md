# Custom Realtime Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one schema-typed realtime publishing facade on the application, tRPC context, and background contexts so custom writes can emit the same access-filtered SSE events as generated CRUD.

**Architecture:** Add a small `RealtimeFacade<TSchema>` adapter that translates a Drizzle table object into the physical table name and delegates to the existing memory or Redis broker. `createBunderstack()` constructs the facade once and injects that same object into the app, tRPC, queue-job, cron, and CRUD paths; subscriber filtering and transport behavior remain inside the broker.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, Hono, tRPC, SSE, libSQL, Redis-compatible broker, Bun test.

## Global Constraints

- Use Bun commands exclusively.
- Preserve the single Web Standard `app.handler(Request) -> Promise<Response>` integration point.
- `publish()` accepts a Drizzle table from the application's schema; do not add a string-table-name overload.
- `publish()` requires the table's complete select row and always returns `Promise<void>`.
- Access, read-scope, topic, replay, and Redis fan-out checks remain broker responsibilities.
- The facade is always present; when server realtime is disabled, `enabled` is `false` and `publish()` is a no-op.
- Delivery remains best-effort: realtime transport failure must not turn a committed database write into an application error.
- Do not add automatic Drizzle interception or a `withBroadcast()` helper.
- Publish only after a database write or enclosing transaction has completed.
- Preserve the unrelated existing changes in `packages/bunderstack/src/email.ts` and `.claude/`.

## File map

- Create `packages/bunderstack/src/realtime/facade.ts`: schema-typed public facade and internal broker adapter.
- Create `packages/bunderstack/src/realtime/facade.test.ts`: facade runtime behavior and compile-time table/row constraints.
- Create `packages/bunderstack/src/realtime/app-publish.test.ts`: end-to-end app, tRPC, and job publication through SSE.
- Modify `packages/bunderstack/src/realtime/index.ts`: continue owning broker types and filtering; export no new construction API.
- Modify `packages/bunderstack/src/index.ts`: construct/inject/expose the facade and export its public types.
- Modify `packages/bunderstack/src/trpc.ts`: add schema-aware `ctx.realtime`.
- Modify `packages/bunderstack/src/trpc.test.ts`: provide the required facade in direct context fixtures.
- Modify `packages/bunderstack/src/jobs/define.ts`: add schema-aware `ctx.realtime` to queue and cron handlers.
- Modify `packages/bunderstack/src/jobs/integration.test.ts`: verify local cron receives the facade.
- Modify `packages/bunderstack/src/crud.ts`: route generated write broadcasts through the facade.
- Modify `packages/bunderstack/src/crud-broadcast.test.ts`: adapt the focused CRUD broadcast test to the facade.
- Modify `README.md`, `packages/bunderstack/README.md`, and `website/content/docs/api-reference.mdx`: document custom publication and the complete-row/after-commit requirements.

---

### Task 1: Build the typed realtime facade

**Files:**

- Create: `packages/bunderstack/src/realtime/facade.ts`
- Create: `packages/bunderstack/src/realtime/facade.test.ts`

**Interfaces:**

- Consumes: `RealtimeAction` and `RealtimeBroker` from `packages/bunderstack/src/realtime/index.ts`.
- Produces: `SchemaTable<TSchema>`, `RealtimeFacade<TSchema>`, and internal `createRealtimeFacade<TSchema>(broker?)`.

- [ ] **Step 1: Write failing facade runtime and type tests**

Create `packages/bunderstack/src/realtime/facade.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { RealtimeBroker } from './index'
import { createRealtimeFacade } from './facade'

const boards = sqliteTable('workspace_boards', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const auditLogs = pgTable('audit_log', {
  id: pgText('id').primaryKey(),
  message: pgText('message').notNull(),
})

function recordingBroker(
  events: Array<Record<string, unknown>>,
): RealtimeBroker {
  return {
    async start() {},
    async close() {},
    register: () => ({ id: 'subscriber' }),
    setContext: () => ({ gap: false }),
    unregister() {},
    async publish(table, action, record) {
      events.push({ table, action, record })
    },
  }
}

describe('RealtimeFacade', () => {
  test('derives SQLite and Postgres physical table names and delegates rows', async () => {
    const events: Array<Record<string, unknown>> = []
    const realtime = createRealtimeFacade<{
      boards: typeof boards
      auditLogs: typeof auditLogs
    }>(recordingBroker(events))

    expect(realtime.enabled).toBe(true)
    await realtime.publish(boards, 'create', { id: 'b1', title: 'Board' })
    await realtime.publish(auditLogs, 'delete', {
      id: 'a1',
      message: 'removed',
    })

    expect(events).toEqual([
      {
        table: 'workspace_boards',
        action: 'create',
        record: { id: 'b1', title: 'Board' },
      },
      {
        table: 'audit_log',
        action: 'delete',
        record: { id: 'a1', message: 'removed' },
      },
    ])
  })

  test('is an enabled=false no-op without a broker', async () => {
    const realtime = createRealtimeFacade<{ boards: typeof boards }>()

    expect(realtime.enabled).toBe(false)
    await expect(
      realtime.publish(boards, 'update', { id: 'b1', title: 'Updated' }),
    ).resolves.toBeUndefined()
  })

  test('constrains tables and records to the application schema', () => {
    const realtime = createRealtimeFacade<{ boards: typeof boards }>()

    if (false) {
      // @ts-expect-error users is not part of this application schema
      void realtime.publish(users, 'create', {
        id: 'u1',
        email: 'u@example.com',
      })
      // @ts-expect-error a board record requires title and does not accept email
      void realtime.publish(boards, 'create', {
        id: 'b1',
        email: 'u@example.com',
      })
      // @ts-expect-error action is restricted to create, update, or delete
      void realtime.publish(boards, 'replace', { id: 'b1', title: 'Board' })
    }

    expect(realtime.enabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run the facade test and verify it fails**

Run: `bun test packages/bunderstack/src/realtime/facade.test.ts`

Expected: FAIL because `./facade` does not exist.

- [ ] **Step 3: Implement the facade**

Create `packages/bunderstack/src/realtime/facade.ts`:

```ts
import { getTableName, type InferSelectModel, type Table } from 'drizzle-orm'

import type { RealtimeAction, RealtimeBroker } from './index'

export type SchemaTable<TSchema extends Record<string, unknown>> = Extract<
  TSchema[keyof TSchema],
  Table
>

export interface RealtimeFacade<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly enabled: boolean

  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: RealtimeAction,
    record: InferSelectModel<TTable>,
  ): Promise<void>
}

export function createRealtimeFacade<TSchema extends Record<string, unknown>>(
  broker?: RealtimeBroker,
): RealtimeFacade<TSchema> {
  return {
    enabled: broker !== undefined,
    async publish(table, action, record) {
      if (!broker) return
      await broker.publish(
        getTableName(table),
        action,
        record as unknown as Record<string, unknown>,
      )
    },
  }
}
```

- [ ] **Step 4: Verify facade behavior and static typing**

Run: `bun test packages/bunderstack/src/realtime/facade.test.ts`

Expected: all three tests pass.

Run: `bun run typecheck`

Expected: exit 0 with no diagnostics, including all three `@ts-expect-error` assertions being consumed.

- [ ] **Step 5: Commit the facade**

```bash
git add packages/bunderstack/src/realtime/facade.ts packages/bunderstack/src/realtime/facade.test.ts
git commit -m "feat(realtime): add typed publishing facade"
```

### Task 2: Inject the facade into app, tRPC, jobs, and cron

**Files:**

- Create: `packages/bunderstack/src/realtime/app-publish.test.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/trpc.ts`
- Modify: `packages/bunderstack/src/trpc.test.ts`
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**

- Consumes: `createRealtimeFacade<TSchema>(broker?)` and `RealtimeFacade<TSchema>` from Task 1.
- Produces: `app.realtime`, tRPC `ctx.realtime`, queue-job `ctx.realtime`, and cron `ctx.realtime`, all referencing the facade constructed by `createBunderstack()`.

- [ ] **Step 1: Write the failing end-to-end custom publish test**

Create `packages/bunderstack/src/realtime/app-publish.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { createBunderstack } from '../index'
import { provision } from '../provision'

const avatars = sqliteTable('avatars', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull(),
})

type Event = {
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

async function readData<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<T> {
  const chunk = await reader.read()
  if (chunk.done || !chunk.value) throw new Error('SSE stream ended')
  const frame = new TextDecoder().decode(chunk.value)
  return JSON.parse(frame.replace(/^data: /, '').trim()) as T
}

test('app, tRPC, and job publication share the application SSE broker', async () => {
  const app = await createBunderstack({
    schema: { avatars },
    database: { url: ':memory:' },
    realtime: true,
    access: {
      avatars: {
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
      },
    },
    trpc: (t) =>
      t.router({
        markRunning: t.procedure.mutation(async ({ ctx }) => {
          await ctx.realtime.publish(avatars, 'update', {
            id: 'a1',
            userId: 'u1',
            status: 'running',
          })
          return { published: ctx.realtime.enabled }
        }),
      }),
    jobs: (j) =>
      j.define({
        completeAvatar: j.job({
          input: z.object({ id: z.string() }),
          handler: async ({ id }, ctx) => {
            await ctx.realtime.publish(avatars, 'update', {
              id,
              userId: 'u1',
              status: 'completed',
            })
          },
        }),
      }),
  })
  await provision(app, { force: true })

  const stream = await app.handler(new Request('http://test/api/realtime'))
  const reader = stream.body!.getReader()

  try {
    const connect = await readData<{ clientId: string }>(reader)
    const subscribe = await app.handler(
      new Request('http://test/api/realtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: connect.clientId,
          subscriptions: ['avatars'],
        }),
      }),
    )
    expect(subscribe.status).toBe(200)
    expect(app.realtime.enabled).toBe(true)

    await app.realtime.publish(avatars, 'create', {
      id: 'a1',
      userId: 'u1',
      status: 'pending',
    })
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'create',
      table: 'avatars',
      record: { id: 'a1', status: 'pending' },
    })

    const trpc = await app.handler(
      new Request('http://test/api/trpc/markRunning', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: null }),
      }),
    )
    expect(trpc.status).toBe(200)
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'running' },
    })

    await app.jobs.enqueue('completeAvatar', { id: 'a1' })
    await app.jobs.tick()
    expect(await readData<Event>(reader)).toMatchObject({
      action: 'update',
      record: { id: 'a1', status: 'completed' },
    })
  } finally {
    await reader.cancel()
    await app.close()
  }
})

test('app exposes an enabled=false no-op when realtime is not configured', async () => {
  const app = await createBunderstack({
    schema: { avatars },
    database: { url: ':memory:' },
  })

  expect(app.realtime.enabled).toBe(false)
  await expect(
    app.realtime.publish(avatars, 'update', {
      id: 'a1',
      userId: 'u1',
      status: 'completed',
    }),
  ).resolves.toBeUndefined()
  await app.close()
})
```

- [ ] **Step 2: Run the custom publish test and verify it fails**

Run: `bun test packages/bunderstack/src/realtime/app-publish.test.ts`

Expected: TypeScript/runtime failure because `app.realtime`, `ctx.realtime`, and job `ctx.realtime` do not exist.

- [ ] **Step 3: Add the facade to public context types**

In `packages/bunderstack/src/trpc.ts`, add the type import and property:

```ts
import type { RealtimeFacade } from './realtime/facade'

export type TRPCContext<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  user: AccessUser | null
  env: TEnvResult
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  req: Request
}
```

In `packages/bunderstack/src/jobs/define.ts`, add the type import and property:

```ts
import type { RealtimeFacade } from '../realtime/facade'

export type JobContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  email: EmailFacade
  storage: StorageFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
}
```

- [ ] **Step 4: Construct and inject one facade in `createBunderstack()`**

In `packages/bunderstack/src/index.ts`, import the factory and type:

```ts
import { createRealtimeFacade, type RealtimeFacade } from './realtime/facade'
```

Immediately after broker selection, construct the facade:

```ts
const realtime = createRealtimeFacade<TSchema>(broker)
```

Add the typed property to `BunderstackApp`:

```ts
realtime: RealtimeFacade<TSchema>
```

Add `realtime` to every custom execution context assembled in this file:

```ts
ctx: {
  db: (userDb, env, email, storage, realtime)
}
```

Use that object for `createJobRunner`, the local scheduler's `runCronSlot`, and
`buildCronRouter`. Add `realtime` to the tRPC request context:

```ts
createContext: async () => ({
  db: userDb,
  user: await resolveAccessUser(authResolver, req.headers),
  env,
  email,
  jobs,
  realtime,
  req,
})
```

Expose the same object on the returned application:

```ts
const app = {
  handler,
  db: userDb,
  auth,
  storage,
  realtime,
  router,
  env,
  email,
  jobs: jobs as never,
  startWorker,
  runWorker,
  startCronScheduler,
  close: () => lifecycle.close(),
  get status() {
    return lifecycle.status
  },
  signal: lifecycle.signal,
  trpcRouter,
  manifest: buildManifest({
    schema: options.schema,
    dialect,
    storage: config.storage,
    envConfig: options.env as EnvConfigInput | undefined,
    realtime: Boolean(config.realtime),
    jobs: jobsDefs,
  }),
}
```

Retain the existing explicit `BunderstackApp<TSchema, TAccess,
BucketNamesOf<TStorage>, TEnv, AnyRouter | undefined, JobsDefs | undefined>`
annotation around this object; only the `realtime` property is new.

- [ ] **Step 5: Update direct tRPC context fixtures**

In `packages/bunderstack/src/trpc.test.ts`, import the factory:

```ts
import { createRealtimeFacade } from './realtime/facade'
```

Add the disabled facade to `makeCtx()`:

```ts
function makeCtx(user: TRPCContext<Schema>['user']): TRPCContext<Schema> {
  return {
    db: null as never,
    user,
    env: {},
    email: fakeEmail,
    jobs: { enqueue: async () => ({ id: '' }), tick: async () => {} },
    realtime: createRealtimeFacade<Schema>(),
    req: new Request('http://test/'),
  }
}
```

- [ ] **Step 6: Verify local cron context injection**

In the existing `explicit local cron scheduler runs declared cron handlers`
test in `packages/bunderstack/src/jobs/integration.test.ts`, capture the facade
state from the handler:

```ts
test('explicit local cron scheduler runs declared cron handlers', async () => {
  const runs: Date[] = []
  const realtimeStates: boolean[] = []
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    realtime: true,
    jobs: (j) =>
      j.define({
        everyMinute: j.cron({
          schedule: '* * * * *',
          handler: ({ scheduledFor }, ctx) => {
            runs.push(scheduledFor)
            realtimeStates.push(ctx.realtime.enabled)
          },
        }),
      }),
  })
  await provision(app, { force: true })

  const scheduler = await app.startCronScheduler()
  expect(runs).toHaveLength(1)
  expect(runs[0]!.getTime() % 60_000).toBe(0)
  expect(realtimeStates).toEqual([true])

  await scheduler.close()
  await app.close()
})
```

- [ ] **Step 7: Run focused context and publication tests**

Run: `bun test packages/bunderstack/src/realtime/app-publish.test.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/trpc-mount.test.ts packages/bunderstack/src/jobs/integration.test.ts`

Expected: all tests pass; SSE receives app, tRPC, and job events in order, and local cron observes `realtime.enabled === true`.

Run: `bun run typecheck`

Expected: exit 0 with `app.realtime`, tRPC `ctx.realtime`, and `JobContext.realtime` inferred from the application schema.

- [ ] **Step 8: Commit context wiring**

```bash
git add packages/bunderstack/src/index.ts packages/bunderstack/src/trpc.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/realtime/app-publish.test.ts
git commit -m "feat(realtime): expose publisher on app and contexts"
```

### Task 3: Route generated CRUD through the facade

**Files:**

- Modify: `packages/bunderstack/src/crud.ts`
- Modify: `packages/bunderstack/src/crud-broadcast.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**

- Consumes: `RealtimeFacade<TSchema>` and the application facade created in Task 2.
- Produces: one publication path shared by generated CRUD and custom application code.

- [ ] **Step 1: Change the focused CRUD test to require the facade**

In `packages/bunderstack/src/crud-broadcast.test.ts`, add:

```ts
import { createRealtimeFacade } from './realtime/facade'
```

Replace the router options in `publishes a create event after insert` with:

```ts
const router = buildCrudRouter(schema, db as never, {
  auth: auth as never,
  access,
  realtime: createRealtimeFacade<typeof schema>(broker),
})
```

- [ ] **Step 2: Run the CRUD broadcast test and verify it fails**

Run: `bun test packages/bunderstack/src/crud-broadcast.test.ts`

Expected: FAIL because `buildCrudRouter` still reads the `broker` option and does not accept `realtime`.

- [ ] **Step 3: Replace the broker option with the facade**

In `packages/bunderstack/src/crud.ts`, replace the broker type import with:

```ts
import type { RealtimeFacade } from './realtime/facade'
```

Make router options schema-aware:

```ts
export type CrudRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  auth?: AuthSessionResolver
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}
```

Update the function signature and option destructuring:

```ts
export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: AnyDb,
  options: CrudRouterOptions<TSchema>,
): Hono {
  const router = new Hono()
  const { auth, access, realtime } = options
```

Replace the three publication calls with table-object calls:

```ts
void realtime?.publish(table, 'create', created as never)
```

```ts
void realtime?.publish(table, 'update', rows[0] as never)
```

```ts
void realtime?.publish(table, 'delete', existing[0] as never)
```

The casts are local to the runtime `Object.values(schema)` loop, where
`isTable(table)` has proved the value is a Drizzle table but TypeScript cannot
recover the corresponding member of `TSchema`.

- [ ] **Step 4: Pass the facade from `createBunderstack()`**

In `packages/bunderstack/src/index.ts`, change CRUD construction to:

```ts
const crudRouter = buildCrudRouter(options.schema, userDb, {
  auth: authResolver,
  access: resolvedAccess,
  idempotency: options.idempotency,
  realtime,
})
```

- [ ] **Step 5: Verify CRUD and broker behavior**

Run: `bun test packages/bunderstack/src/crud-broadcast.test.ts packages/bunderstack/src/crud.test.ts packages/bunderstack/src/crud-scope.test.ts packages/bunderstack/src/realtime`

Expected: all CRUD, memory broker, Redis broker, and SSE tests pass.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit the shared CRUD path**

```bash
git add packages/bunderstack/src/crud.ts packages/bunderstack/src/crud-broadcast.test.ts packages/bunderstack/src/index.ts
git commit -m "refactor(realtime): publish CRUD through facade"
```

### Task 4: Export, document, and run full regression verification

**Files:**

- Modify: `packages/bunderstack/src/index.ts`
- Modify: `README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `website/content/docs/api-reference.mdx`

**Interfaces:**

- Consumes: the completed `RealtimeFacade<TSchema>` application API.
- Produces: root package type exports and user-facing guidance for tRPC, jobs, complete rows, transactions, and disabled realtime.

- [ ] **Step 1: Export the public realtime types**

Add these root exports to `packages/bunderstack/src/index.ts`:

```ts
export type { RealtimeAction } from './realtime/index'
export type { RealtimeFacade, SchemaTable } from './realtime/facade'
```

Do not export `createRealtimeFacade`, `RealtimeBroker`, subscriber registration,
or broker lifecycle methods from the package root.

- [ ] **Step 2: Add the server usage guide to both READMEs**

In `README.md`, add this section immediately before the `## Development`
heading. In `packages/bunderstack/README.md`, add it immediately before the
`## Shipping TypeScript source` heading:

````markdown
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
````

- [ ] **Step 3: Extend the website API reference**

In the `BunderstackApp` type block in
`website/content/docs/api-reference.mdx`, add:

```ts
/** Typed custom row publication; enabled=false/no-op when realtime is off. */
realtime: RealtimeFacade<TSchema>
```

Add this section before `## Client packages`:

````markdown
## Custom realtime publication

Auto-CRUD broadcasts successful writes automatically. Custom tRPC procedures,
jobs, cron handlers, and code using `app.db` publish explicitly through the
same access-filtered broker:

```ts
const [row] = await ctx.db
  .update(schema.avatars)
  .set({ status: 'completed' })
  .where(eq(schema.avatars.id, avatarId))
  .returning()

await ctx.realtime.publish(schema.avatars, 'update', row)
```

```ts
interface RealtimeFacade<TSchema> {
  readonly enabled: boolean
  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: 'create' | 'update' | 'delete',
    record: InferSelectModel<TTable>,
  ): Promise<void>
}
```

The facade is available on `app`, tRPC context, and queue-job/cron context.
Always pass the complete post-write row returned by `.returning()`; delete uses
the complete pre-delete row. Publish after the database write or enclosing
transaction resolves. Access and read-scope filtering, replay, and Redis
multi-instance delivery are applied by the broker. Publication is best-effort,
and it resolves as a no-op when realtime is disabled.
````

- [ ] **Step 4: Run formatting and inspect its scope**

Run: `bunx oxfmt packages/bunderstack/src/realtime/facade.ts packages/bunderstack/src/realtime/facade.test.ts packages/bunderstack/src/realtime/app-publish.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/trpc.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/crud.ts packages/bunderstack/src/crud-broadcast.test.ts README.md packages/bunderstack/README.md website/content/docs/api-reference.mdx`

Expected: formatter exits 0 and changes only the listed feature files. Confirm
with `git status --short`; the pre-existing `packages/bunderstack/src/email.ts`
and `.claude/` entries remain untouched.

- [ ] **Step 5: Run focused verification**

Run: `bun test packages/bunderstack/src/realtime packages/bunderstack/src/crud-broadcast.test.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/trpc-mount.test.ts packages/bunderstack/src/jobs/integration.test.ts`

Expected: all focused realtime, CRUD, tRPC, and background-context tests pass.

Run: `bun run typecheck`

Expected: exit 0 with no diagnostics.

- [ ] **Step 6: Run the complete workspace test suite**

Run: `bun run test`

Expected: every `bunderstack`, `bunderstack-query`, `bunderstack-sync`,
`bunderstack-start`, and scripts test passes.

- [ ] **Step 7: Review the final diff for scope and API consistency**

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

Run: `git diff -- packages/bunderstack/src/realtime packages/bunderstack/src/index.ts packages/bunderstack/src/trpc.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/crud.ts packages/bunderstack/src/crud-broadcast.test.ts README.md packages/bunderstack/README.md website/content/docs/api-reference.mdx`

Expected: the diff contains only the typed facade, injection/reuse changes,
tests, exports, and documentation described by this plan. It contains no
changes to broker filtering, wire payloads, Redis behavior, or unrelated files.

- [ ] **Step 8: Commit exports and documentation**

```bash
git add packages/bunderstack/src/index.ts README.md packages/bunderstack/README.md website/content/docs/api-reference.mdx
git commit -m "docs(realtime): document custom row publication"
```
