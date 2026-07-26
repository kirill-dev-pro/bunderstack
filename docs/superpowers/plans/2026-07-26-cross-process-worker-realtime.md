# Cross-Process Worker Realtime Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Bunderstack from silently accepting an in-memory realtime broker in a standalone worker process where job publications cannot reach browser SSE subscribers.

**Architecture:** Keep the existing memory broker for single-process and embedded-worker development, and keep Redis as the shared cross-process transport. Make the selected transport observable through `RealtimeFacade`, reject unsafe `runWorker()` startup unless the caller explicitly opts into process-local delivery, prove Redis fan-out across independent broker instances, and expose the transport requirement in the deployment manifest. No application polling fallback and no automatic Redis process management are added.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SSE, Bun Redis client, Bun test.

## Global Constraints

- Use Bun commands exclusively.
- Preserve `realtime.enabled` for backward compatibility.
- `realtime: true` continues to select the memory broker when no Redis URL is configured.
- `startWorker()` remains valid with the memory broker because it is the documented embedded/same-process API.
- `runWorker()` is treated as the standalone-process API and must not silently use process-local realtime.
- Callers whose jobs never publish realtime may explicitly pass `allowProcessLocalRealtime: true`.
- Redis remains selected by `realtime.redis`, validated `env.REDIS_URL`, or `process.env.REDIS_URL`.
- Application construction and `BUNDERSTACK_INTROSPECT=1` must not connect to Redis or start timers.
- Realtime publication remains best-effort; Redis failures must not roll back committed database writes.
- Do not add client polling or a database outbox in this change.

---

## File Map

- `packages/bunderstack/src/realtime/facade.ts` — public realtime capability metadata and typed publish facade.
- `packages/bunderstack/src/realtime/facade.test.ts` — transport metadata unit tests.
- `packages/bunderstack/src/realtime/redis.test.ts` — cross-instance Redis fan-out regression test.
- `packages/bunderstack/src/index.ts` — broker selection, standalone-worker safety gate, public option types, and manifest wiring.
- `packages/bunderstack/src/jobs/integration.test.ts` — public `runWorker()` behavior tests.
- `packages/bunderstack/src/manifest.ts` — deploy-time realtime transport requirements.
- `packages/bunderstack/src/manifest.test.ts` — manifest contract tests.
- `packages/bunderstack/src/app-env.test.ts` — application-level manifest assertion.
- `README.md` — top-level worker and realtime configuration guidance.
- `packages/bunderstack/README.md` — published package guidance.
- `docs/superpowers/specs/2026-06-27-durable-realtime-design.md` — correct the claim that Redis never affects correctness.

---

### Task 1: Expose the selected realtime transport

**Files:**
- Modify: `packages/bunderstack/src/realtime/facade.ts`
- Modify: `packages/bunderstack/src/realtime/facade.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**
- Produces: `RealtimeTransport = 'disabled' | 'memory' | 'redis'`.
- Produces: `RealtimeFacade.transport: RealtimeTransport`.
- Produces: `createRealtimeFacade(broker?, transport?)`.
- Preserves: `RealtimeFacade.enabled: boolean`.

- [ ] **Step 1: Write failing facade tests**

Add tests that construct all three facade modes:

```ts
import type { RealtimeBroker } from './index'
import {
  createRealtimeFacade,
  type RealtimeTransport,
} from './facade'

const broker: RealtimeBroker = {
  async start() {},
  async close() {},
  register: () => ({ id: 'client-1' }),
  setContext: () => ({ gap: false }),
  unregister() {},
  publish() {},
}

test('realtime facade reports disabled without a broker', () => {
  const realtime = createRealtimeFacade()
  expect(realtime.enabled).toBe(false)
  expect(realtime.transport).toBe('disabled')
})

test.each([
  ['memory', 'memory'],
  ['redis', 'redis'],
] satisfies [RealtimeTransport, RealtimeTransport][])(
  'realtime facade reports %s transport',
  (transport, expected) => {
    const realtime = createRealtimeFacade(broker, transport)
    expect(realtime.enabled).toBe(true)
    expect(realtime.transport).toBe(expected)
  },
)
```

- [ ] **Step 2: Run the facade test and verify RED**

Run:

```bash
bun test packages/bunderstack/src/realtime/facade.test.ts
```

Expected: FAIL because `RealtimeTransport`, `transport`, and the second `createRealtimeFacade` argument do not exist.

- [ ] **Step 3: Add transport metadata to the facade**

Implement:

```ts
export type RealtimeTransport = 'disabled' | 'memory' | 'redis'

export interface RealtimeFacade<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly enabled: boolean
  readonly transport: RealtimeTransport

  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: RealtimeAction,
    record: InferSelectModel<TTable>,
  ): Promise<void>
}

export function createRealtimeFacade<
  TSchema extends Record<string, unknown>,
>(
  broker?: RealtimeBroker,
  transport: RealtimeTransport = broker ? 'memory' : 'disabled',
): RealtimeFacade<TSchema> {
  if (!broker && transport !== 'disabled') {
    throw new Error(
      '[bunderstack] an enabled realtime transport requires a broker',
    )
  }
  if (broker && transport === 'disabled') {
    throw new Error(
      '[bunderstack] a realtime broker cannot use the disabled transport',
    )
  }

  return {
    enabled: broker !== undefined,
    transport,
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

In `createBunderstack()`, derive the runtime transport from the selected broker:

```ts
const realtimeTransport: RealtimeTransport = !config.realtime
  ? 'disabled'
  : redisUrl
    ? 'redis'
    : 'memory'

const realtime = createRealtimeFacade<TSchema>(broker, realtimeTransport)
```

Import and re-export `RealtimeTransport` beside the existing realtime public types.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
bun test packages/bunderstack/src/realtime/facade.test.ts packages/bunderstack/src/realtime/app-publish.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: both test files PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the transport capability**

```bash
git add packages/bunderstack/src/realtime/facade.ts packages/bunderstack/src/realtime/facade.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(realtime): expose selected transport"
```

---

### Task 2: Reject unsafe standalone workers

**Files:**
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**
- Consumes: `RealtimeFacade.transport` from Task 1.
- Produces: `AppRunWorkerOptions.allowProcessLocalRealtime?: boolean`.
- Preserves: `AppStartWorkerOptions` without the override because embedded workers are safe.

- [ ] **Step 1: Write the failing public API tests**

Add one rejection test and one explicit-override test:

```ts
test('runWorker rejects process-local realtime by default', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    realtime: true,
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
  })
  await provision(app, { force: true })

  await expect(
    app.runWorker({ signal: AbortSignal.abort(), pollIntervalMs: 1 }),
  ).rejects.toThrow(
    '[bunderstack] runWorker() cannot deliver realtime events through the in-memory broker',
  )
  expect(app.status).toBe('ready')
  await app.close()
})

test('runWorker allows an explicit process-local realtime override', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    realtime: true,
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
  })
  await provision(app, { force: true })

  await expect(
    app.runWorker({
      signal: AbortSignal.abort(),
      pollIntervalMs: 1,
      allowProcessLocalRealtime: true,
    }),
  ).resolves.toBeUndefined()
  expect(app.status).toBe('closed')
})
```

- [ ] **Step 2: Run the integration tests and verify RED**

Run:

```bash
bun test packages/bunderstack/src/jobs/integration.test.ts
```

Expected: the default-rejection assertion fails and TypeScript does not accept `allowProcessLocalRealtime`.

- [ ] **Step 3: Separate standalone options from embedded options**

Replace the alias:

```ts
export type AppRunWorkerOptions = AppStartWorkerOptions & {
  /**
   * Permit process-local realtime in a standalone worker.
   *
   * Use only when job handlers never call ctx.realtime.publish(). Publications
   * made through the memory broker cannot reach SSE clients in another process.
   */
  allowProcessLocalRealtime?: boolean
}
```

At the beginning of `runWorker()`, before `startWorker()`:

```ts
if (
  realtime.transport === 'memory' &&
  !options.allowProcessLocalRealtime
) {
  throw new Error(
    '[bunderstack] runWorker() cannot deliver realtime events through the in-memory broker. Configure REDIS_URL or realtime.redis, embed the worker with startWorker(), or pass allowProcessLocalRealtime: true only when jobs never publish realtime.',
  )
}
```

Destructure the library-only option before forwarding options:

```ts
const {
  allowProcessLocalRealtime: _allowProcessLocalRealtime,
  ...workerOptions
} = options
const handle = await startWorker(workerOptions)
```

Use `workerOptions.signal` for shutdown signal composition so the new field never leaks into `startJobWorker()`.

- [ ] **Step 4: Run worker and type tests**

Run:

```bash
bun test packages/bunderstack/src/jobs/integration.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the standalone-worker guard**

```bash
git add packages/bunderstack/src/index.ts packages/bunderstack/src/jobs/integration.test.ts
git commit -m "fix(jobs): reject process-local realtime in standalone workers"
```

---

### Task 3: Prove Redis delivery across independent broker instances

**Files:**
- Modify: `packages/bunderstack/src/realtime/redis.test.ts`

**Interfaces:**
- Consumes: `createRedisRealtimeBroker`.
- Verifies: a publisher broker does not need local SSE subscribers and can deliver to subscribers registered on another broker through the shared Redis channel.

- [ ] **Step 1: Add the missing cross-instance regression test**

Use the existing shared fake Redis server:

```ts
it('fans out worker publications to subscribers on another broker instance', async () => {
  const redis = makeFakeRedis()
  const webBroker = createRedisRealtimeBroker({ access, redis })
  const workerBroker = createRedisRealtimeBroker({ access, redis })

  await webBroker.start()
  const browser = sub(webBroker, 'org_1', ['boards'])

  await workerBroker.publish('boards', 'update', {
    id: 'b1',
    organizationId: 'org_1',
    title: 'Completed by worker',
  })

  expect(browser.received).toEqual([
    {
      eventId: 1,
      action: 'update',
      table: 'boards',
      record: {
        id: 'b1',
        organizationId: 'org_1',
        title: 'Completed by worker',
      },
    },
  ])

  await workerBroker.close()
  await webBroker.close()
})
```

- [ ] **Step 2: Temporarily point the publisher at a separate fake and verify the test fails**

Before accepting the test, run it once with:

```ts
const workerBroker = createRedisRealtimeBroker({
  access,
  redis: makeFakeRedis(),
})
```

Run:

```bash
bun test packages/bunderstack/src/realtime/redis.test.ts \
  --test-name-pattern "another broker instance"
```

Expected: FAIL because `browser.received` is empty. Restore the shared `redis` instance immediately afterward.

- [ ] **Step 3: Run the restored cross-instance test**

Run:

```bash
bun test packages/bunderstack/src/realtime/redis.test.ts \
  --test-name-pattern "another broker instance"
```

Expected: PASS with the shared Redis transport.

- [ ] **Step 4: Run the complete realtime suite**

Run:

```bash
bun test packages/bunderstack/src/realtime
```

Expected: all realtime tests PASS.

- [ ] **Step 5: Commit the regression coverage**

```bash
git add packages/bunderstack/src/realtime/redis.test.ts
git commit -m "test(realtime): cover cross-instance worker fan-out"
```

---

### Task 4: Express realtime transport requirements in the manifest

**Files:**
- Modify: `packages/bunderstack/src/manifest.ts`
- Modify: `packages/bunderstack/src/manifest.test.ts`
- Modify: `packages/bunderstack/src/app-env.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**
- Consumes: `RealtimeTransport` from Task 1.
- Produces: additive `manifest.realtimeTransport: RealtimeTransport`.
- Preserves: `manifest.version === 2` and `manifest.realtime: boolean`.

- [ ] **Step 1: Write failing manifest tests**

Update `buildManifest()` fixtures to pass `realtimeTransport` and assert both the legacy and additive fields:

```ts
const manifest = buildManifest({
  schema: { posts },
  dialect: 'sqlite',
  storage,
  envConfig,
  realtime: true,
  realtimeTransport: 'redis',
  jobs: undefined,
})

expect(manifest.realtime).toBe(true)
expect(manifest.realtimeTransport).toBe('redis')
```

Add a disabled assertion:

```ts
expect(
  buildManifest({
    schema: { posts },
    dialect: 'sqlite',
    storage,
    envConfig: undefined,
    realtime: false,
    realtimeTransport: 'disabled',
    jobs: undefined,
  }).realtimeTransport,
).toBe('disabled')
```

In `app-env.test.ts`, assert:

```ts
expect(app.manifest.realtime).toBe(false)
expect(app.manifest.realtimeTransport).toBe('disabled')
```

- [ ] **Step 2: Run manifest tests and verify RED**

Run:

```bash
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/app-env.test.ts
```

Expected: FAIL because `realtimeTransport` is absent from the manifest type and builder.

- [ ] **Step 3: Add the additive manifest field**

Extend the manifest:

```ts
export type BunderstackManifest = {
  version: 2
  // existing fields
  realtime: boolean
  realtimeTransport: RealtimeTransport
  // existing fields
}
```

Extend `buildManifest` input and result:

```ts
export function buildManifest(args: {
  // existing fields
  realtime: boolean
  realtimeTransport: RealtimeTransport
  jobs: JobsDefs | undefined
}): BunderstackManifest {
  return {
    // existing fields
    realtime: args.realtime,
    realtimeTransport: args.realtimeTransport,
    // existing fields
  }
}
```

In `createBunderstack()`, distinguish configured transport from connection startup:

```ts
const configuredRedisUrl = config.realtime
  ? resolveRealtimeRedisUrl(config.realtime, env)
  : undefined
const configuredRealtimeTransport: RealtimeTransport = !config.realtime
  ? 'disabled'
  : configuredRedisUrl
    ? 'redis'
    : 'memory'
const redisUrl = introspect ? undefined : configuredRedisUrl
```

Continue suppressing Redis construction during introspection. Pass `configuredRealtimeTransport` into `buildManifest()`; pass the actual runtime transport into the facade:

```ts
const runtimeRealtimeTransport: RealtimeTransport = !broker
  ? 'disabled'
  : redisUrl
    ? 'redis'
    : 'memory'

const realtime = createRealtimeFacade<TSchema>(
  broker,
  runtimeRealtimeTransport,
)

manifest: buildManifest({
  // existing arguments
  realtime: Boolean(config.realtime),
  realtimeTransport: configuredRealtimeTransport,
  jobs: jobsDefs,
})
```

- [ ] **Step 4: Verify manifest, introspection, and dependency boundaries**

Run:

```bash
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/app-env.test.ts
bun test scripts/dependency-boundaries.test.ts scripts/bundle-boundaries.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: all tests PASS, introspection performs no Redis connection, and TypeScript exits 0.

- [ ] **Step 5: Commit the manifest capability**

```bash
git add packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(manifest): describe realtime transport"
```

---

### Task 5: Document the standalone-worker contract

**Files:**
- Modify: `README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `docs/superpowers/specs/2026-06-27-durable-realtime-design.md`

**Interfaces:**
- Consumes: `RealtimeFacade.transport`, `allowProcessLocalRealtime`, and `manifest.realtimeTransport`.
- Produces: copy-pasteable configuration for standalone worker realtime.

- [ ] **Step 1: Put the Redis requirement beside the worker example**

Immediately after the distinct web/worker snippets in `README.md`, add:

```md
If a queue handler calls `ctx.realtime.publish()`, the web and worker processes
must share a realtime transport. Configure `REDIS_URL` (or
`realtime: { redis: "redis://..." }`). `realtime: true` without Redis uses a
process-local memory broker and is suitable only when the worker is embedded
with `app.startWorker()`.

`app.runWorker()` rejects that unsafe combination by default. If queue handlers
never publish realtime events, acknowledge the process-local behavior with
`app.runWorker({ allowProcessLocalRealtime: true })`.
```

- [ ] **Step 2: Add the same contract to the published package README**

After the `await app.runWorker()` example in `packages/bunderstack/README.md`, add the same requirement and these configuration examples:

```ts
const app = await createBunderstack({
  // ...
  realtime: { redis: process.env.REDIS_URL! },
})
```

```bash
REDIS_URL=redis://localhost:6379 bun src/server.ts
REDIS_URL=redis://localhost:6379 bun src/worker.ts
```

- [ ] **Step 3: Correct the durable realtime design claim**

Replace the unconditional “Correctness never depends on Redis” claim with:

```md
Correctness does not depend on Redis while publishers and SSE subscribers share
one process: reconnect gaps fall back to a full refetch. Cross-process
publication is different. A standalone queue worker has no access to the web
process's memory broker, so Redis (or another shared transport) is required for
worker events to reach browser subscribers.
```

- [ ] **Step 4: Run documentation and package verification**

Run:

```bash
rg -n "allowProcessLocalRealtime|REDIS_URL|process-local|realtimeTransport" \
  README.md packages/bunderstack/README.md \
  docs/superpowers/specs/2026-06-27-durable-realtime-design.md
bun run typecheck
bun run test
bun run typecheck:examples
```

Expected:

- `rg` finds the standalone-worker constraint in both READMEs and the corrected design statement.
- all package tests PASS;
- workspace and example typechecks exit 0.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md packages/bunderstack/README.md docs/superpowers/specs/2026-06-27-durable-realtime-design.md
git commit -m "docs: require shared realtime for standalone workers"
```

---

## Final Verification

- [ ] Run the full workspace test suite:

```bash
bun run test
```

Expected: every package and script test passes.

- [ ] Run all typechecks:

```bash
bun run typecheck:all
```

Expected: library and example typechecks exit 0.

- [ ] Review the final diff:

```bash
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors; only the planned files are modified; the five focused commits are present.

## Follow-Up Outside This Repository

Bunderhost should consume `manifest.realtimeTransport` in a separate implementation plan. When a deployment contains queue jobs and configured transport `memory`, the platform must either provision/inject a shared Redis URL or reject the deployment with the same actionable explanation. This follow-up is intentionally separate because no Bunderhost package exists in this repository.
