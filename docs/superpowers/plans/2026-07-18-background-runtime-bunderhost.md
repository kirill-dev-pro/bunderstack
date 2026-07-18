# Bunderhost Background Runtime Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume Bunderstack manifest v2, deploy production queue workers as explicit Fly Machines, and dispatch production cron schedules through signed HTTP without per-customer cron Machines.

**Architecture:** The builder produces a web image and an optional platform-owned worker image from the same `src/bunderstack.ts` declaration. The Fly driver manages role-labelled web and worker Machines independently. One global Bunderhost scheduler reconciles manifest schedules into durable dispatch rows and wakes scale-to-zero web Machines with signed requests.

**Tech Stack:** Bun, TypeScript, Bunderstack manifest v2, Drizzle/libSQL, Fly Machines API, Hono/TanStack Start, Bun test.

## Global Constraints

- Apply this plan in `/Users/kirill/pet-projects/bunderhost` after the Bunderstack library plan is complete and locally available to Bunderhost.
- Use Bun commands exclusively.
- Deploy queue workers only for production environments with `manifest.background.jobs.length > 0`.
- Never dispatch customer cron or deploy customer workers for preview environments by default.
- Cron-only applications must retain one scale-to-zero web Machine and no customer worker Machine.
- The web and worker use the same database, bucket, secrets, and immutable source revision.
- Worker Machines have no public Fly service and use restart policy `always`.
- Five-field cron is evaluated by Bunderhost in UTC; Fly's fuzzy native schedule is not used.
- Every Fly Machine must carry `metadata['bunderhost.role']` equal to `web` or `worker`.
- Reject unsupported manifest versions before provisioning or deploying runtime resources.
- Treat `manifest.tableMap` and `manifest.systemTables` as the sole allow-list
  for the later Project Explorer; never reconstruct physical table names.

---

### Task 1: Adopt and validate manifest v2

**Files:**
- Modify: `package.json`
- Modify: `src/ports.ts`
- Create: `src/manifest.ts`
- Create: `src/manifest.test.ts`
- Modify: `src/builder.ts`
- Modify: `src/builder.test.ts`

**Interfaces:**
- Consumes: `BunderstackManifest` v2 from the completed library plan.
- Produces: `parseManifest(value): BunderstackManifest` and `BuildResult { webImage, workerImage?, manifest }`.

- [ ] **Step 1: Upgrade the Bunderstack dependency**

Point `bunderstack` and related packages at the first local/published version
that exports manifest v2 and `bunderstack/cron`. Run `bun install` so the lockfile
records the exact version.

- [ ] **Step 2: Write manifest validation tests**

Cover valid v2, missing background fields, unknown version, duplicate job/cron
names, missing `tableMap`/`systemTables`, and invalid cron schedules. The
unsupported-version assertion is:

```ts
test('rejects a manifest version the platform does not understand', () => {
  expect(() => parseManifest({ version: 3 })).toThrow(
    '[bunderhost] unsupported bunderstack manifest version 3; expected 2',
  )
})
```

- [ ] **Step 3: Verify the tests fail**

Run: `bun test src/manifest.test.ts`

Expected: failure because `parseManifest` does not exist.

- [ ] **Step 4: Implement strict parsing**

Define a Zod schema that exactly validates version `2`, existing resource/env
fields, and:

```ts
background: z.object({
  jobs: z.array(z.object({ name: z.string().min(1) })),
  cron: z.array(
    z.object({
      name: z.string().min(1),
      schedule: z.string().refine((value) => {
        try {
          parseCron(value)
          return true
        } catch {
          return false
        }
      }),
      timezone: z.literal('UTC'),
    }),
  ),
  maintenance: z.array(
    z.object({
      name: z.literal('storage-sweep'),
      schedule: z.string().refine((value) => {
        try {
          parseCron(value)
          return true
        } catch {
          return false
        }
      }),
    }),
  ),
})
```

After Zod parsing, reject duplicate names within each collection. Call
`parseManifest(JSON.parse(payload))` from `DockerBuilder.introspect()`.

The same Zod object must require:

```ts
tableMap: z.record(z.string().min(1), z.string().min(1)),
systemTables: z.object({
  jobs: z.string().min(1),
  files: z.string().min(1),
  scheduledRuns: z.string().min(1),
}),
```

Keep `tables` as logical schema keys. A stored manifest that lacks these fields
is not deployable under manifest v2 and must be redeployed before Explorer
resource routes can use it.

- [ ] **Step 5: Change build result naming**

Replace `BuildResult.image` with:

```ts
export type BuildResult = {
  webImage: string
  workerImage?: string
  manifest: BunderstackManifest
}
```

Update fakes and current call sites to use `webImage`; worker image production
is added in Task 2.

- [ ] **Step 6: Verify manifest and existing builder behavior**

Run: `bun test src/manifest.test.ts src/builder.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/manifest.ts src/manifest.test.ts src/ports.ts src/builder.ts src/builder.test.ts src/testing/fakes.ts
git commit -m "feat(manifest)!: adopt bunderstack manifest v2"
```

### Task 2: Build an optional companion worker image

**Files:**
- Modify: `src/builder.ts`
- Modify: `src/builder.test.ts`

**Interfaces:**
- Consumes: validated manifest and the `src/bunderstack.ts` entry convention.
- Produces: `workerImage` only when queue jobs are declared.

- [ ] **Step 1: Write builder tests for all background combinations**

Add cases asserting:

```ts
expect(await buildWith({ jobs: [], cron: [] })).toMatchObject({
  workerImage: undefined,
})
expect(await buildWith({ jobs: [], cron: [hourlyCron] })).toMatchObject({
  workerImage: undefined,
})
expect(await buildWith({ jobs: [{ name: 'email' }], cron: [] })).toMatchObject({
  workerImage: 'registry.fly.io/bh-x:abc-worker',
})
```

Inspect recorded commands and assert that the worker build uses its own generated
Dockerfile even when the repository contains a custom web Dockerfile.

- [ ] **Step 2: Verify the worker-image test fails**

Run: `bun test src/builder.test.ts`

Expected: failure because only one image is built.

- [ ] **Step 3: Generate the worker entrypoint**

When `manifest.background.jobs.length > 0`, write
`.bunderhost/worker.ts` with exact content:

```ts
import { app } from '../src/bunderstack.ts'

await app.runWorker()
```

Create `generateWorkerDockerfile()` returning:

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun build --compile --target=bun-linux-x64 --outfile /out/worker .bunderhost/worker.ts

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/worker ./worker
ENV NODE_ENV=production
CMD ["./worker"]
```

If migrations exist, copy them into the worker image using the same relative
path as the web image.

- [ ] **Step 4: Build and push the worker tag**

Use `${imageBase}:${shortSha}-worker`, disable provenance as for the web image,
and return it as `workerImage`. Keep a single registry login per build.

- [ ] **Step 5: Verify builder output**

Run: `bun test src/builder.test.ts`

Expected: all web-only, cron-only, and queue-job cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/builder.ts src/builder.test.ts
git commit -m "feat(builder): produce companion queue worker image"
```

### Task 3: Model web and worker Machines as separate runtime roles

**Files:**
- Modify: `src/ports.ts`
- Modify: `src/fly.ts`
- Modify: `src/fly.test.ts`
- Modify: `src/testing/fakes.ts`

**Interfaces:**
- Consumes: web and worker OCI images.
- Produces: role-aware runtime deployment and listing APIs.

- [ ] **Step 1: Write role-specific Fly tests**

Keep the current web test and add:

```ts
test('deployWorker creates a private always-on machine', async () => {
  const { fn, calls } = fakeFetch([
    () => json({ id: 'worker-1' }),
    () => json({}),
    () => json({ id: 'worker-1', state: 'started' }),
  ])
  const result = await driver(fn).deployWorker({
    appName: 'bh-x-prod',
    image: 'registry.fly.io/bh-x-prod:abc-worker',
    env: { BUNDERSTACK_DATABASE_URL: 'libsql://x' },
  })
  expect(result.machineId).toBe('worker-1')

  const config = JSON.parse(calls[0]!.init.body as string).config
  expect(config.metadata['bunderhost.role']).toBe('worker')
  expect(config.services).toEqual([])
  expect(config.restart).toEqual({ policy: 'always' })
})
```

Also test `listMachines(appName, 'web')` and `'worker'` filtering through the
Fly metadata query.

- [ ] **Step 2: Verify role tests fail**

Run: `bun test src/fly.test.ts`

Expected: failure because role-specific methods do not exist.

- [ ] **Step 3: Replace the runtime port**

Define:

```ts
export type MachineRole = 'web' | 'worker'
export type MachineDeployResult = { machineId: string }
export type WebDeployResult = MachineDeployResult & { url: string }

export interface RuntimeDriver {
  ensureApp(appName: string): Promise<{ url: string }>
  deployWeb(args: {
    appName: string
    image: string
    env: Record<string, string>
  }): Promise<WebDeployResult>
  deployWorker(args: {
    appName: string
    image: string
    env: Record<string, string>
  }): Promise<MachineDeployResult>
  listMachines(appName: string, role: MachineRole): Promise<string[]>
  destroyMachine(appName: string, machineId: string): Promise<void>
  destroyApp(appName: string): Promise<void>
}
```

- [ ] **Step 4: Implement role-specific Fly configuration**

Rename current `deploy` to `deployWeb`, add metadata
`{ 'bunderhost.role': 'web' }`, and preserve HTTP health checks. Implement
`deployWorker` with no services, 256 MB memory, restart policy `always`, worker
metadata, wait-for-started, then one delayed GET of the Machine to ensure it
remains in `started` state. Do not call the public HTTP health endpoint for a
worker.

Filter machine listing with
`?metadata.bunderhost.role=${encodeURIComponent(role)}` and retain the
non-destroyed-state filter.

- [ ] **Step 5: Update the fake runtime**

Track `deployedWeb`, `deployedWorkers`, and role-specific machine arrays. Keep
failure injection separate so orchestration tests can fail only worker rollout.

- [ ] **Step 6: Verify Fly and fake behavior**

Run: `bun test src/fly.test.ts src/testing/fakes.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ports.ts src/fly.ts src/fly.test.ts src/testing/fakes.ts src/testing/fakes.test.ts
git commit -m "feat(runtime): add explicit web and worker machine roles"
```

### Task 4: Persist worker identity and cron credentials

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/deploy-env.ts`
- Modify: `src/deploy-env.test.ts`
- Create: `src/cron-secret.ts`
- Create: `src/cron-secret.test.ts`
- Create: `src/cron-schema.test.ts`

**Interfaces:**
- Consumes: existing environment secret encryption and deployment records.
- Produces: encrypted environment cron secret, worker Machine ID, durable cron dispatches, and scheduler cursor.

- [ ] **Step 1: Write schema and deploy-env tests**

Assert that a newly created environment has a decryptable 32-byte cron secret,
that a legacy environment with no secret is lazily backfilled exactly once,
that composed deployment env contains `BUNDERSTACK_CRON_SECRET`, and that user
secrets cannot override it.

- [ ] **Step 2: Add control-plane columns and tables**

Add nullable `cronSecretEncrypted: text('cronSecretEncrypted')` to
`environments`, `workerMachineId: text('workerMachineId')` to `deployments`, and:

```ts
export const cronDispatches = sqliteTable(
  'cronDispatches',
  {
    id: typeid('cron_dispatch').primaryKey().$defaultFn(() => generateTypeId('cron_dispatch')),
    environmentId: typeid('env').notNull().references(() => environments.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    scheduledAt: integer('scheduledAt', { mode: 'timestamp' }).notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('nextAttemptAt', { mode: 'timestamp' }).notNull(),
    lastError: text('lastError'),
    deliveredAt: integer('deliveredAt', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('cron_dispatch_slot').on(
      t.environmentId,
      t.kind,
      t.name,
      t.scheduledAt,
    ),
  ],
)

export const schedulerState = sqliteTable('schedulerState', {
  key: text('key').primaryKey(),
  lastEvaluatedSlot: integer('lastEvaluatedSlot', { mode: 'timestamp' }).notNull(),
})
```

- [ ] **Step 3: Generate and inject the cron secret**

Generate 32 random bytes alongside `AUTH_SECRET`, encrypt them with the existing
master-key helpers, and store them on environment creation. Add
`ensureCronSecret(environmentId)` for pre-existing rows: inside a transaction,
create a secret only when the column is null, then read and decrypt the winning
value so concurrent calls converge. Call it before web deployment and scheduler
dispatch. Extend `composeDeployEnv` with `cronSecret: string`; spread user
secrets first and set `BUNDERSTACK_CRON_SECRET` after them. The nullable schema
is an intentional rolling-upgrade bridge, not an optional runtime invariant.

- [ ] **Step 4: Verify schema and environment composition**

Run: `bun test src/cron-schema.test.ts src/cron-secret.test.ts src/deploy-env.test.ts src/orchestrator.test.ts`

Expected: all tests pass with fixtures covering both populated and legacy-null
secret fields.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/cron-schema.test.ts src/cron-secret.ts src/cron-secret.test.ts src/orchestrator.ts src/deploy-env.ts src/deploy-env.test.ts src/testing
git commit -m "feat(cron): persist dispatch state and environment credentials"
```

### Task 5: Deploy web and worker generations safely

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/orchestrator.test.ts`
- Modify: `src/deploy-logger.ts`

**Interfaces:**
- Consumes: role-aware runtime, optional worker image, manifest v2, and expanded deployment row.
- Produces: production blue-green rollout for both roles and web-only preview rollout.

- [ ] **Step 1: Write orchestration tests for the deployment matrix**

Cover:

- production with queue jobs deploys web then worker;
- production with cron only deploys web only;
- preview with queue jobs deploys web only;
- worker rollout failure leaves old web and old worker alive and destroys the
  failed new web/worker generation;
- removing the final queue job destroys the old worker after new web health;
- web cleanup never destroys a worker ID.

Assert log steps `web.deploy`, `worker.deploy`, and `worker.remove`.

- [ ] **Step 2: Verify matrix tests fail**

Run: `bun test src/orchestrator.test.ts`

Expected: failure because orchestration deploys a single unlabelled Machine.

- [ ] **Step 3: Implement role-aware rollout order**

In `deployEnvironment`:

1. Reject non-v2 manifest before resource provisioning.
2. List old web and worker IDs separately.
3. Deploy and health-check the new web image.
4. When `environment.name === 'production'` and jobs exist, require
   `workerImage`, deploy the new worker, and retain its ID.
5. When any new role fails, destroy every newly created role and retain all old
   roles.
6. After both required roles succeed, destroy old web IDs and then old worker
   IDs.
7. When jobs were removed, destroy old worker IDs only after the new web is
   healthy.
8. Persist `machineId` and nullable `workerMachineId` on the live deployment.

- [ ] **Step 4: Verify orchestration and reaper behavior**

Run: `bun test src/orchestrator.test.ts src/orchestrator-preview.test.ts src/reaper.test.ts`

Expected: all tests pass and teardown removes both roles through the existing
app-wide destruction path.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts src/orchestrator.test.ts src/deploy-logger.ts src/reaper.test.ts
git commit -m "feat(deploy): roll out explicit production workers"
```

### Task 6: Build durable signed cron dispatching

**Files:**
- Create: `src/cron-dispatcher.ts`
- Create: `src/cron-dispatcher.test.ts`
- Modify: `src/ports.ts`
- Modify: `src/testing/fakes.ts`

**Interfaces:**
- Consumes: live production manifests, encrypted cron secrets, `parseCron`,
  `cronMatches`, and `signScheduleRequest` from `bunderstack/cron`.
- Produces: `createCronDispatchesForSlots()` and `deliverPendingCronDispatches()`.

- [ ] **Step 1: Write due-slot reconciliation tests**

Given a cursor at 12:00 and current time 12:03, assert that all three elapsed UTC
minute slots are evaluated, only matching schedules are inserted, duplicate
reconciliation creates no duplicate rows, preview environments are ignored,
catch-up is capped at 60 minutes, completed rows older than 90 days are removed,
and pending rows are retained regardless of age.

- [ ] **Step 2: Write delivery tests**

Use an injected fetch. Assert:

```ts
expect(request.url).toBe(
  'https://bh-app.fly.dev/api/_bunderstack/cron/hourly',
)
expect(request.headers.get('X-Bunderstack-Cron-Slot')).toBe(String(slot))
expect(request.headers.get('X-Bunderstack-Cron-Signature')).toBe(
  await signScheduleRequest(secret, 'cron:hourly', slot),
)
```

Test `200` as delivered; `202`, `429`, `5xx`, and network failure as retryable;
`400`, `401`, and `404` as terminal configuration failures; exponential retry
minutes `1, 2, 4, 8, 16`; and maximum five attempts.

- [ ] **Step 3: Verify dispatcher tests fail**

Run: `bun test src/cron-dispatcher.test.ts`

Expected: failure because dispatcher functions do not exist.

- [ ] **Step 4: Implement transactional schedule reconciliation**

Use one transaction to read the `production-cron` scheduler cursor, enumerate
minute-aligned slots through the current minute, insert unique dispatch rows with
`onConflictDoNothing`, and advance the cursor. On first run, initialize the
cursor to one minute before the current slot so the current minute is evaluated
without replaying earlier history. If the gap exceeds 60 minutes, start at
`current - 59 minutes` and emit one warning. During reconciliation, delete
delivered or terminal dispatch rows older than 90 days; retain pending rows.

Map user cron to `kind: 'cron'`. Map manifest maintenance entries to
`kind: 'maintenance'` so delivery can select the correct protected endpoint.
The canonical signed task ID is `cron:<name>` for user tasks and
`maintenance:<name>` for platform tasks.

- [ ] **Step 5: Implement bounded delivery retries**

Select pending rows with `nextAttemptAt <= now`, decrypt the environment secret,
convert the Drizzle `scheduledAt: Date` value to epoch milliseconds exactly
once, sign the canonical task and numeric slot, and send the request. Update the
row after every response. Never hold a database transaction open across
`fetch`.

Use these targets:

```ts
const pathname =
  dispatch.kind === 'cron'
    ? `/api/_bunderstack/cron/${encodeURIComponent(dispatch.name)}`
    : `/api/_bunderstack/maintenance/${encodeURIComponent(dispatch.name)}`
```

- [ ] **Step 6: Verify reconciliation and delivery**

Run: `bun test src/cron-dispatcher.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cron-dispatcher.ts src/cron-dispatcher.test.ts src/ports.ts src/testing/fakes.ts
git commit -m "feat(cron): dispatch production schedules over signed HTTP"
```

### Task 7: Add the single global scheduler process

**Files:**
- Create: `src/platform-scheduler.ts`
- Create: `src/platform-scheduler.test.ts`
- Modify: `package.json`
- Modify: `src/deps.ts`

**Interfaces:**
- Consumes: cron reconciliation/delivery functions and real control-plane dependencies.
- Produces: one long-running Bunderhost scheduler process shared by all hosted applications.

- [ ] **Step 1: Write loop lifecycle tests**

Inject the clock, sleep, reconcile, and deliver functions. Assert immediate
startup execution, next-minute alignment, no overlapping cycles, error logging
without process exit, abort-driven shutdown, and signal-listener cleanup.

- [ ] **Step 2: Verify lifecycle tests fail**

Run: `bun test src/platform-scheduler.test.ts`

Expected: failure because the scheduler process does not exist.

- [ ] **Step 3: Implement the scheduler loop**

Expose `runPlatformScheduler({ signal, now, reconcile, deliver, logger })`. Each
cycle reconciles slots, delivers due rows in batches of 50 until none remain,
then sleeps until the next UTC minute boundary. The executable entry creates an
AbortController, installs one-shot `SIGINT`/`SIGTERM` handlers, awaits the loop,
and removes handlers in `finally`.

- [ ] **Step 4: Add the Bun process script**

Add:

```json
"scheduler": "bun src/platform-scheduler.ts"
```

Wire real DB, encryption, logger, and fetch dependencies through `deps.ts`.

- [ ] **Step 5: Verify scheduler behavior**

Run: `bun test src/platform-scheduler.test.ts src/cron-dispatcher.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json src/platform-scheduler.ts src/platform-scheduler.test.ts src/deps.ts
git commit -m "feat(platform): add shared cron scheduler process"
```

### Task 8: Expose background deployment consequences in the product

**Files:**
- Modify: `src/project-detail.ts`
- Modify: `src/routes/_authed/projects.$projectId.index.tsx`
- Modify: `src/components/DeploymentsTable.tsx`
- Modify: `src/components/DeployLogPanel.tsx`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-16-bunderhost-design.md`

**Interfaces:**
- Consumes: manifest v2 and deployment `workerMachineId`.
- Produces: dashboard and documentation that make always-on worker cost/runtime explicit.

- [ ] **Step 1: Extend project detail data**

Return:

```ts
background: {
  workerRequired: manifest.background.jobs.length > 0,
  queueJobs: manifest.background.jobs.map((job) => job.name),
  cron: manifest.background.cron,
  previewExecution: 'disabled',
}
```

Use an empty equivalent before the first successful introspection.

- [ ] **Step 2: Render the runtime summary**

Show:

- `Web: scale-to-zero`;
- `Worker: always-on` plus queue job count when required;
- `Cron: platform dispatched` plus schedule count;
- `Preview background execution: disabled`.

Show worker Machine identity/status separately from the web Machine in deployment
details. Label the worker as additional compute rather than an implementation
detail.

- [ ] **Step 3: Update platform documentation**

Document the manifest decision matrix, production-only default, same-image/same-
resource contract, signed delivery, retry semantics, and the operational cost of
declaring the first queue job. Replace the old statement that application cron
always runs inside the web process.

- [ ] **Step 4: Verify UI types and tests**

Run: `bun run typecheck`

Expected: exit 0.

Run: `bun test src/project-detail.ts src/app-api.test.ts`

Expected: all related tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-16-bunderhost-design.md src/project-detail.ts src/routes/_authed/projects.$projectId.index.tsx src/components/DeploymentsTable.tsx src/components/DeployLogPanel.tsx src/app-api.test.ts
git commit -m "docs: make worker and cron deployment roles explicit"
```

### Task 9: Final platform verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all preceding Bunderhost tasks and the completed Bunderstack release.
- Produces: evidence for one production deployment matrix and no preview background execution.

- [ ] **Step 1: Run formatting and linting**

Run: `bun run format`

Expected: exit 0.

Run: `bun run lint`

Expected: exit 0.

- [ ] **Step 2: Run static checking and tests**

Run: `bun run typecheck`

Expected: exit 0.

Run: `bun test`

Expected: zero failures.

- [ ] **Step 3: Inspect generated deployment artifacts**

Run the builder tests with command recording and verify:

- web-only manifest -> one web image;
- cron-only manifest -> one web image;
- queue-job manifest -> web and worker images;
- worker Dockerfile imports the same `src/bunderstack.ts` declaration.

- [ ] **Step 4: Run a manual preview smoke test**

Deploy a fixture manifest containing both one job and one cron into a preview
environment. Expected: one public web Machine, no worker Machine, no cron
dispatch row, and dashboard label `Preview background execution: disabled`.

- [ ] **Step 5: Run a manual production smoke test**

Deploy the same fixture into production. Expected: one scale-to-zero web Machine,
one private always-on worker Machine, an enqueued job consumed by the worker, and
a signed cron delivery waking the web Machine and recording a succeeded slot.

- [ ] **Step 6: Commit formatting-only changes if produced**

Run `git status --short` and `git diff --name-only`. If formatting changed
tracked files, stage each reported path explicitly only after confirming it was
already modified by Tasks 1–8, then commit with
`chore: finalize background runtime deployment`. Never use `git add .`; skip
this commit when verification produced no tracked changes.
