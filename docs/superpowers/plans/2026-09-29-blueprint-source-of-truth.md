# Blueprint as the source of truth (bunderstack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 1.0 app commits only `bunderstack.blueprint.yaml` (version 2); `wrangler.json` is derived from it and git-ignored; hosts build their deploy config from `workerPlanFromBlueprint`.

**Architecture:** The blueprint schema becomes a union of version 1 (0.x server contract, still parsed for Bunderhost's 0.x path) and version 2 (Worker contract, the only one the generator writes). A pure `src/worker-plan.ts` turns a version 2 blueprint into a name-free `WorkerPlan`; `wrangler.json` is a thin render of the plan. `bunderstack dev`/`build` generate the blueprint first and `wrangler.json` from it.

**Tech Stack:** Bun, TypeScript, valibot, `yaml`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-29-blueprint-source-of-truth-design.md`

## Global Constraints

- Work in the `next` worktree: `/Users/kirill/Projects/bunderstack-project/bunderstack/.claude/worktrees/next`. Never change `main`.
- Package version after this plan: `1.0.0-beta.3`, published with the `next` npm tag.
- The generator writes only `version: 2`. The parser accepts `version: 1` and `version: 2`.
- Version 2 `application.worker` keys: `main`, `compatibilityDate` (`YYYY-MM-DD`), `assets`. Defaults for a new file: `src/worker.ts`, today's UTC date, `dist/client`.
- Durable Object binding names stay `SCHEDULER`, `REALTIME`, `RATE_LIMITER`; classes `Scheduler`, `RealtimeHub`, `RateLimiter`; migration tag `v1`.
- Cloudflare free-plan cron limit: more than 5 schedules collapse to `* * * * *`.
- Format only touched files with `bunx oxfmt <paths>`; never `bun run fix` (it rewrites docs).
- Package tests: `cd packages/bunderstack && bun test <file>`. Commit after every task with a `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
- 8 tests fail on clean `main` before this work; compare against a baseline run instead of chasing them.

---

### Task 1: Version 1 and version 2 blueprint schemas

**Files:**
- Modify: `packages/bunderstack/src/blueprint.ts`
- Test: `packages/bunderstack/src/blueprint.test.ts`

**Interfaces:**
- Produces:
  - `type WorkerSettings = { main: string; compatibilityDate: string; assets: string }`
  - `type LegacyBlueprint` (version 1), `type WorkerBlueprint` (version 2), `type BunderstackBlueprint = LegacyBlueprint | WorkerBlueprint`
  - `parseBlueprint(value: unknown): BunderstackBlueprint`
  - `parseBlueprintYaml(source: string): BunderstackBlueprint`
  - `parseWorkerBlueprint(value: unknown): WorkerBlueprint`
  - `parseWorkerBlueprintYaml(source: string): WorkerBlueprint`
  - `blueprintFromManifest(args: { manifest; generatorVersion; entry; migrationMode; framework?; worker: WorkerSettings }): WorkerBlueprint`
  - `serializeBlueprint(value: BunderstackBlueprint): string` (signature unchanged)
  - `ApplicationRuntime` is deleted.

- [ ] **Step 1: Record a baseline of the package tests**

Run: `cd packages/bunderstack && bun test 2>&1 | tail -5`
Save the pass/fail counts in your notes; later tasks compare against them.

- [ ] **Step 2: Rewrite the blueprint tests for the new shape**

In `packages/bunderstack/src/blueprint.test.ts`:

1. Add near the top, after `manifest`:

```ts
const WORKER = {
  main: 'src/worker.ts',
  compatibilityDate: '2026-09-28',
  assets: 'dist/client',
}

const legacySource = {
  version: 1,
  generator: { name: 'bunderstack', version: '0.25.2' },
  application: {
    framework: 'tanstack-start',
    scripts: { build: 'build', start: 'start', worker: 'worker' },
  },
  bunderstack: { entry: 'src/bunderstack.ts', manifestVersion: 4 },
  resources: {
    database: {
      dialect: 'sqlite',
      migrationsDirectory: 'migrations',
      migrationMode: 'migrations',
      tables: [],
    },
    storage: {
      defaultBucket: 'images',
      buckets: [{ name: 'images', visibility: 'private' }],
    },
    messaging: { channels: [] },
  },
  environment: [],
  background: {
    worker: { required: true },
    jobs: [{ name: 'work' }],
    cron: [],
    maintenance: [],
  },
}
```

2. Add `worker: WORKER` to every existing `blueprintFromManifest({ ... })` call in the file.
3. In `'blueprint converts a manifest to canonical YAML'`, replace `expect(blueprint.background.worker).toEqual({ required: true })` with:

```ts
  expect(blueprint.version).toBe(2)
  expect(blueprint.application.worker).toEqual(WORKER)
  expect('worker' in blueprint.background).toBe(false)
```

4. Delete the test `'blueprint supports worker runtime without start or companion worker scripts'`.
5. Update the imports to `blueprintFromManifest, isSensitiveEnvVar, parseBlueprint, parseBlueprintYaml, parseWorkerBlueprint, serializeBlueprint`.
6. Append:

```ts
test('a 0.25.x version 1 blueprint still parses as the legacy contract', () => {
  const legacy = parseBlueprint(legacySource)
  expect(legacy.version).toBe(1)
  if (legacy.version !== 1) throw new Error('unreachable')
  expect(legacy.application.scripts.start).toBe('start')
  expect(legacy.background.worker).toEqual({ required: true })
  expect(parseBlueprintYaml(serializeBlueprint(legacy))).toEqual(legacy)
})

test('parseWorkerBlueprint rejects a version 1 blueprint with the upgrade step', () => {
  expect(() => parseWorkerBlueprint(legacySource)).toThrow(
    /run `bunderstack dev` or `bunderstack blueprint`/,
  )
})

test('a beta.2 version 1 blueprint with runtime: worker must be regenerated', () => {
  expect(() =>
    parseBlueprint({
      ...legacySource,
      application: {
        runtime: 'worker',
        framework: 'solid',
        scripts: { build: 'build' },
      },
    }),
  ).toThrow(/regenerate the blueprint with bunderstack 1.0.0-beta.3/)
})

test('version 2 requires application.worker with safe paths and a date', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: WORKER,
  })
  const { worker: _worker, ...application } = blueprint.application
  expect(() => parseBlueprint({ ...blueprint, application })).toThrow()
  for (const worker of [
    { ...WORKER, main: '../worker.ts' },
    { ...WORKER, assets: '/abs' },
    { ...WORKER, compatibilityDate: '28.09.2026' },
  ]) {
    expect(() =>
      parseBlueprint({
        ...blueprint,
        application: { ...blueprint.application, worker },
      }),
    ).toThrow()
  }
  expect(() =>
    parseBlueprint({
      ...blueprint,
      application: {
        ...blueprint.application,
        scripts: { build: 'build', start: 'start' },
      },
    }),
  ).toThrow(/version 2 blueprint declares only the build script/)
})

test('version 2 serializes the worker section and round-trips', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    framework: 'solid',
    worker: WORKER,
  })
  const yaml = serializeBlueprint(blueprint)
  expect(yaml).toStartWith('version: 2\n')
  expect(yaml).toMatch(/compatibilityDate: "?2026-09-28"?\n/)
  expect(yaml).not.toContain('runtime:')
  expect(parseWorkerBlueprint(parseBlueprintYaml(yaml))).toEqual(blueprint)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/bunderstack && bun test src/blueprint.test.ts`
Expected: FAIL — `parseWorkerBlueprint` is not exported, and `blueprintFromManifest` still returns version 1.

- [ ] **Step 4: Implement the union schema**

In `packages/bunderstack/src/blueprint.ts`:

1. Delete `export type ApplicationRuntime = 'server' | 'worker'`.
2. Replace the `BunderstackBlueprint` type with:

```ts
export type WorkerSettings = {
  main: string
  compatibilityDate: string
  assets: string
}

type BlueprintBackground = Pick<
  BunderstackManifest['background'],
  'jobs' | 'cron' | 'maintenance'
>

type BlueprintBody = {
  generator: { name: 'bunderstack'; version: string }
  bunderstack: { entry: string; manifestVersion: 4 }
  resources: {
    database: BunderstackManifest['database'] & { migrationMode: MigrationMode }
    storage: BunderstackManifest['storage']
    realtime?: { required: true }
    messaging: BunderstackManifest['messaging']
  }
  environment: BlueprintEnvVar[]
  /** Application-declared procedures. Absent in blueprints written before 0.23.0. */
  api?: { operations: BunderstackManifest['api']['operations'] }
}

/** The 0.x server contract. Parsed for hosts; never generated by 1.0. */
export type LegacyBlueprint = BlueprintBody & {
  version: 1
  application: {
    framework: ApplicationFramework
    scripts: { build: 'build'; start: 'start'; worker?: 'worker' }
  }
  background: BlueprintBackground & { worker: { required: boolean } }
}

/** The 1.0 Worker contract. */
export type WorkerBlueprint = BlueprintBody & {
  version: 2
  application: {
    framework: ApplicationFramework
    scripts: { build: 'build' }
    worker: WorkerSettings
  }
  background: BlueprintBackground
}

export type BunderstackBlueprint = LegacyBlueprint | WorkerBlueprint
```

3. Replace `const blueprintSchema = open({ ... })` with shared entries and a variant. Keep the inner definitions exactly as they are today; only the grouping changes:

```ts
const compatibilityDate = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/, 'compatibilityDate must be YYYY-MM-DD'),
)
const framework = v.picklist(['tanstack-start', 'solid', 'bun-ssr', 'custom'])

const sharedEntries = {
  generator: open({ name: v.literal('bunderstack'), version: nonEmpty }),
  bunderstack: open({ entry: relativePath, manifestVersion: v.literal(4) }),
  resources: /* the existing resources: open({ ... }) schema, unchanged */,
  environment: /* the existing environment: v.array(...) schema, unchanged */,
  api: /* the existing api: v.optional(...) schema, unchanged */,
}

const backgroundEntries = {
  jobs: v.array(open({ name: nonEmpty })),
  cron: /* the existing cron array schema, unchanged */,
  maintenance: /* the existing maintenance array schema, unchanged */,
}

const legacySchema = open({
  version: v.literal(1),
  ...sharedEntries,
  application: open({
    framework,
    scripts: open({
      build: v.literal('build'),
      start: v.literal('start'),
      worker: v.optional(v.literal('worker')),
    }),
  }),
  background: open({
    worker: open({ required: v.boolean() }),
    ...backgroundEntries,
  }),
})

const workerSchema = open({
  version: v.literal(2),
  ...sharedEntries,
  application: open({
    framework,
    scripts: open({ build: v.literal('build') }),
    worker: open({ main: relativePath, compatibilityDate, assets: relativePath }),
  }),
  background: open(backgroundEntries),
})

const blueprintSchema = v.variant('version', [legacySchema, workerSchema])
```

Move the existing inline `resources`, `environment`, `api`, `cron`, and `maintenance` schema bodies into these constants by cut-and-paste; do not change them.

4. In `parseBlueprint`, before `validateStandardSchema`, reject the beta.2 shape:

```ts
  const raw = value as {
    version?: unknown
    application?: { runtime?: unknown }
  } | null
  if (raw?.version === 1 && raw.application?.runtime === 'worker') {
    throw new Error(
      '[bunderstack] this version 1 blueprint declares runtime: worker; regenerate the blueprint with bunderstack 1.0.0-beta.3',
    )
  }
```

5. Replace the block from `const runtime = blueprint.application.runtime ?? 'server'` to the end of the runtime checks with:

```ts
  if (blueprint.version === 1) {
    const workerRequired = blueprint.background.jobs.length > 0
    if (blueprint.background.worker.required !== workerRequired) {
      throw new Error(
        '[bunderstack] background worker.required must match declared queue jobs',
      )
    }
    if (Boolean(blueprint.application.scripts.worker) !== workerRequired) {
      throw new Error(
        '[bunderstack] application worker script must match declared queue jobs',
      )
    }
  } else {
    const scripts = blueprint.application.scripts as Record<string, unknown>
    if (Object.keys(scripts).some((name) => name !== 'build')) {
      throw new Error(
        '[bunderstack] a version 2 blueprint declares only the build script',
      )
    }
  }
  return blueprint
```

6. Add after `parseBlueprint`:

```ts
export function parseWorkerBlueprint(value: unknown): WorkerBlueprint {
  const blueprint = parseBlueprint(value)
  if (blueprint.version !== 2) {
    throw new Error(
      '[bunderstack] bunderstack.blueprint.yaml is a 0.x (version 1) blueprint; run `bunderstack dev` or `bunderstack blueprint` to regenerate it for 1.0',
    )
  }
  return blueprint
}
```

and after `parseBlueprintYaml`:

```ts
export function parseWorkerBlueprintYaml(source: string): WorkerBlueprint {
  return parseWorkerBlueprint(parse(source) as unknown)
}
```

7. Rewrite `blueprintFromManifest`:

```ts
export function blueprintFromManifest(args: {
  manifest: BunderstackManifest
  generatorVersion: string
  entry: string
  migrationMode: MigrationMode
  framework?: ApplicationFramework
  worker: WorkerSettings
}): WorkerBlueprint {
  return parseWorkerBlueprint({
    version: 2,
    generator: { name: 'bunderstack', version: args.generatorVersion },
    application: {
      framework: args.framework ?? 'tanstack-start',
      scripts: { build: 'build' },
      worker: args.worker,
    },
    bunderstack: { entry: args.entry, manifestVersion: 4 },
    resources: /* unchanged from today */,
    environment: sortBy(args.manifest.environment, (entry) => entry.key),
    api: { operations: args.manifest.api.operations },
    background: {
      jobs: sortBy(args.manifest.background.jobs, (entry) => entry.name),
      cron: sortBy(args.manifest.background.cron, (entry) => entry.name),
      maintenance: sortBy(
        args.manifest.background.maintenance,
        (entry) => entry.name,
      ),
    },
  })
}
```

- [ ] **Step 5: Run the blueprint tests**

Run: `cd packages/bunderstack && bun test src/blueprint.test.ts`
Expected: PASS. If an existing test fails because it asserted a version 1 detail of a generated blueprint (`start` script, `background.worker`), change the assertion to the version 2 equivalent; do not weaken other assertions.

- [ ] **Step 6: Typecheck and fix callers**

Run: `cd packages/bunderstack && bunx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected errors only in `blueprint-generator.ts` (fixed in Task 4) and possibly `hosted-contract.ts`. `hosted-contract.ts` reads only shared sections and must compile unchanged against the union; if it does not, narrow nothing and fix the type access so it reads the shared fields. Leave the generator errors for Task 4, but do not commit a package that fails `tsc`: add `worker: { main: 'src/worker.ts', compatibilityDate: new Date().toISOString().slice(0, 10), assets: 'dist/client' }` to the generator's `blueprintFromManifest` call and delete its `runtime` argument as a temporary bridge. Task 4 replaces it.

- [ ] **Step 7: Commit**

```bash
bunx oxfmt packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/blueprint-generator.ts
git add packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/blueprint-generator.ts
git commit -m "feat(blueprint)!: version 2 Worker blueprint; version 1 parses for hosts only"
```

---

### Task 2: `WorkerPlan` from a version 2 blueprint

**Files:**
- Create: `packages/bunderstack/src/worker-plan.ts`
- Create: `packages/bunderstack/src/worker-plan.test.ts`
- Modify: `packages/bunderstack/src/blueprint.ts` (re-export)
- Modify: `packages/bunderstack/src/workers/r2.ts:13-15` (import `bucketBindingName` from the plan module and re-export it)
- Modify: `packages/bunderstack/src/workers/index.ts` (export the plan)

**Interfaces:**
- Consumes: `WorkerBlueprint` from Task 1.
- Produces:

```ts
export type WorkerPlan = {
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: {
    bindings: { name: string; className: string }[]
    migrations: { tag: string; newSqliteClasses: string[] }[]
  }
  buckets: { name: string; binding: string }[]
  crons: string[]
  assets: { directory: string; runWorkerFirst: string[] }
}
export function workerPlanFromBlueprint(blueprint: WorkerBlueprint): WorkerPlan
export function bucketBindingName(bucketName: string): string
```

Both are importable from `bunderstack/blueprint` (no runtime) and `bunderstack/workers`.

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/worker-plan.test.ts`:

```ts
import { expect, test } from 'bun:test'

import type { WorkerBlueprint } from './blueprint'

import { workerPlanFromBlueprint } from './worker-plan'

const sweep = {
  name: 'storage-sweep' as const,
  schedule: '0 4 * * *',
  timezone: 'UTC' as const,
}

function blueprint(
  overrides: {
    buckets?: WorkerBlueprint['resources']['storage']['buckets']
    background?: WorkerBlueprint['background']
  } = {},
): WorkerBlueprint {
  return {
    version: 2,
    generator: { name: 'bunderstack', version: '1.0.0-beta.3' },
    application: {
      framework: 'solid',
      scripts: { build: 'build' },
      worker: {
        main: 'src/worker.ts',
        compatibilityDate: '2026-09-28',
        assets: 'dist/client',
      },
    },
    bunderstack: { entry: 'src/bunderstack.ts', manifestVersion: 4 },
    resources: {
      database: {
        dialect: 'sqlite',
        migrationsDirectory: 'migrations',
        migrationMode: 'push',
        tables: [],
      },
      storage: {
        defaultBucket: 'media',
        buckets: overrides.buckets ?? [
          { name: 'media', visibility: 'private' },
          { name: 'public-files', visibility: 'public' },
        ],
      },
      messaging: { channels: [] },
    },
    environment: [],
    api: {
      operations: [
        {
          handle: 'hook',
          operationId: 'hook',
          effect: 'mutation',
          method: 'POST',
          path: '/webhooks/stripe',
        },
        { handle: 'rpcOnly', operationId: 'rpcOnly', effect: 'unknown' },
      ],
    },
    background: overrides.background ?? {
      jobs: [{ name: 'work' }],
      cron: [{ name: 'digest', schedule: '0 8 * * *', timezone: 'UTC' }],
      maintenance: [sweep],
    },
  }
}

test('the plan carries the Worker settings, DOs, buckets, routes, and crons', () => {
  expect(workerPlanFromBlueprint(blueprint())).toEqual({
    main: 'src/worker.ts',
    compatibilityDate: '2026-09-28',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      bindings: [
        { name: 'SCHEDULER', className: 'Scheduler' },
        { name: 'REALTIME', className: 'RealtimeHub' },
        { name: 'RATE_LIMITER', className: 'RateLimiter' },
      ],
      migrations: [
        {
          tag: 'v1',
          newSqliteClasses: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
        },
      ],
    },
    buckets: [
      { name: 'media', binding: 'BUCKET_MEDIA' },
      { name: 'public-files', binding: 'BUCKET_PUBLIC_FILES' },
    ],
    crons: ['0 4 * * *', '0 8 * * *'],
    assets: {
      directory: 'dist/client',
      runWorkerFirst: ['/api/*', '/webhooks/*'],
    },
  })
})

test('no buckets: no sweep cron; more than five crons collapse', () => {
  const cron = Array.from({ length: 6 }, (_, i) => ({
    name: `c${i}`,
    schedule: `${i} * * * *`,
    timezone: 'UTC' as const,
  }))
  const plan = workerPlanFromBlueprint(
    blueprint({ buckets: [], background: { jobs: [], cron, maintenance: [sweep] } }),
  )
  expect(plan.buckets).toEqual([])
  expect(plan.crons).toEqual(['* * * * *'])
})

test('no cron and no buckets means no crons', () => {
  const plan = workerPlanFromBlueprint(
    blueprint({ buckets: [], background: { jobs: [], cron: [], maintenance: [sweep] } }),
  )
  expect(plan.crons).toEqual([])
})

test('a blueprint without api operations routes only /api through the Worker', () => {
  const { api: _api, ...withoutApi } = blueprint()
  expect(workerPlanFromBlueprint(withoutApi).assets.runWorkerFirst).toEqual([
    '/api/*',
  ])
})

test('the plan is a fresh object each time', () => {
  const source = blueprint()
  const plan = workerPlanFromBlueprint(source)
  plan.crons.push('mutated')
  expect(workerPlanFromBlueprint(source).crons).not.toContain('mutated')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/bunderstack && bun test src/worker-plan.test.ts`
Expected: FAIL — cannot find module `./worker-plan`.

- [ ] **Step 3: Implement the module**

Create `packages/bunderstack/src/worker-plan.ts`:

```ts
// src/worker-plan.ts — what a Worker app needs from its host, derived only
// from the committed version 2 blueprint. Physical names (script, buckets) are
// the renderer's job: `wrangler.json` locally, a host's own config in hosting.
import type { WorkerBlueprint } from './blueprint'

/** Cloudflare's per-Worker Cron Trigger limit on the free plan. */
const MAX_CRONS = 5

export type WorkerPlan = {
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: {
    bindings: { name: string; className: string }[]
    migrations: { tag: string; newSqliteClasses: string[] }[]
  }
  buckets: { name: string; binding: string }[]
  crons: string[]
  assets: { directory: string; runWorkerFirst: string[] }
}

export function bucketBindingName(bucketName: string): string {
  return `BUCKET_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export function workerPlanFromBlueprint(blueprint: WorkerBlueprint): WorkerPlan {
  const { worker } = blueprint.application
  const buckets = blueprint.resources.storage.buckets
  const crons = [
    ...new Set([
      ...blueprint.background.cron.map((cron) => cron.schedule),
      ...(buckets.length > 0
        ? blueprint.background.maintenance.map((task) => task.schedule)
        : []),
    ]),
  ].sort()
  // Operations without their own path are served through /api/rpc.
  const runWorkerFirst = [
    ...new Set([
      '/api/*',
      ...(blueprint.api?.operations ?? [])
        .filter((op) => op.path)
        .map((op) => `/${op.path!.split('/')[1]}/*`),
    ]),
  ]
  return {
    main: worker.main,
    compatibilityDate: worker.compatibilityDate,
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      bindings: [
        { name: 'SCHEDULER', className: 'Scheduler' },
        { name: 'REALTIME', className: 'RealtimeHub' },
        { name: 'RATE_LIMITER', className: 'RateLimiter' },
      ],
      migrations: [
        {
          tag: 'v1',
          newSqliteClasses: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
        },
      ],
    },
    buckets: buckets.map((bucket) => ({
      name: bucket.name,
      binding: bucketBindingName(bucket.name),
    })),
    crons: crons.length > MAX_CRONS ? ['* * * * *'] : crons,
    assets: { directory: worker.assets, runWorkerFirst },
  }
}
```

In `packages/bunderstack/src/blueprint.ts`, at the end:

```ts
export {
  bucketBindingName,
  workerPlanFromBlueprint,
  type WorkerPlan,
} from './worker-plan'
```

In `packages/bunderstack/src/workers/r2.ts`, delete the local `bucketBindingName` function and add:

```ts
import { bucketBindingName } from '../worker-plan'

export { bucketBindingName }
```

In `packages/bunderstack/src/workers/index.ts`, add to the exports:

```ts
export { workerPlanFromBlueprint, type WorkerPlan } from '../worker-plan'
```

- [ ] **Step 4: Run tests and boundary checks**

Run: `cd packages/bunderstack && bun test src/worker-plan.test.ts src/workers/r2.test.ts src/blueprint.test.ts`
Expected: PASS.
Run (repo root): `bun run test:boundaries && bun run test:bundles`
Expected: PASS. If a boundary rule rejects `blueprint.ts` → `worker-plan.ts`, add `worker-plan.ts` to the same allow-list entry as `blueprint.ts`, since both are pure.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt packages/bunderstack/src/worker-plan.ts packages/bunderstack/src/worker-plan.test.ts packages/bunderstack/src/blueprint.ts packages/bunderstack/src/workers/r2.ts packages/bunderstack/src/workers/index.ts
git add -A packages/bunderstack/src scripts
git commit -m "feat(workers): WorkerPlan from a version 2 blueprint"
```

---

### Task 3: `wrangler.json` rendered from the blueprint

**Files:**
- Modify: `packages/bunderstack/src/workers/wrangler.ts`
- Modify: `packages/bunderstack/src/workers/wrangler.test.ts`
- Modify: `packages/bunderstack/src/cli.ts` (wrangler options and help)
- Modify: `packages/bunderstack/src/cli.test.ts:116-170` (wrangler test)

**Interfaces:**
- Consumes: `WorkerPlan`, `workerPlanFromBlueprint` (Task 2), `parseWorkerBlueprintYaml` (Task 1).
- Produces:
  - `toWranglerConfig(plan: WorkerPlan, names: { name: string; bucketName: (logical: string) => string }): WranglerConfig`
  - `runWranglerCommand(options: { directory: string; name?: string; output?: string }): Promise<{ path: string; changed: boolean }>` — reads `bunderstack.blueprint.yaml`, never imports app code.
  - `loadBackend` stays exported unchanged (used by `dev/push.ts`).
  - Removed: `buildWranglerConfig`, `WranglerCheckError`, the `--entry`, `--assets`, and `--check` wrangler flags.

- [ ] **Step 1: Rewrite the wrangler unit tests**

Replace `packages/bunderstack/src/workers/wrangler.test.ts` with:

```ts
import { expect, test } from 'bun:test'

import type { WorkerPlan } from '../worker-plan'

import { toWranglerConfig } from './wrangler'

const plan: WorkerPlan = {
  main: 'src/worker.ts',
  compatibilityDate: '2026-09-28',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    bindings: [
      { name: 'SCHEDULER', className: 'Scheduler' },
      { name: 'REALTIME', className: 'RealtimeHub' },
      { name: 'RATE_LIMITER', className: 'RateLimiter' },
    ],
    migrations: [
      {
        tag: 'v1',
        newSqliteClasses: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
      },
    ],
  },
  buckets: [{ name: 'media', binding: 'BUCKET_MEDIA' }],
  crons: ['0 4 * * *', '0 8 * * *'],
  assets: { directory: 'dist/client', runWorkerFirst: ['/api/*', '/webhooks/*'] },
}

test('wrangler.json is the plan with local physical names', () => {
  expect(
    toWranglerConfig(plan, {
      name: 'fikflix',
      bucketName: (bucket) => `fikflix-${bucket}`,
    }),
  ).toEqual({
    name: 'fikflix',
    main: 'src/worker.ts',
    compatibility_date: '2026-09-28',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: {
      bindings: [
        { name: 'SCHEDULER', class_name: 'Scheduler' },
        { name: 'REALTIME', class_name: 'RealtimeHub' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
      ],
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
      },
    ],
    r2_buckets: [{ binding: 'BUCKET_MEDIA', bucket_name: 'fikflix-media' }],
    assets: {
      directory: 'dist/client',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*', '/webhooks/*'],
    },
    triggers: { crons: ['0 4 * * *', '0 8 * * *'] },
  })
})

test('no crons means no triggers key', () => {
  const config = toWranglerConfig(
    { ...plan, crons: [] },
    { name: 'app', bucketName: (bucket) => bucket },
  )
  expect('triggers' in config).toBe(false)
})
```

- [ ] **Step 2: Rewrite the CLI wrangler test**

In `packages/bunderstack/src/cli.test.ts`, replace the test `'wrangler CLI generates, then reports current, then catches drift'` with a test whose app directory contains only `package.json` and a blueprint, and a `src/bunderstack.ts` that throws on import (this proves the command does not load app code):

```ts
test('wrangler CLI renders wrangler.json from the blueprint without app code', async () => {
  const dir = join(tmpdir(), `bunderstack-wrangler-${crypto.randomUUID()}`)
  await mkdir(join(dir, 'src'), { recursive: true })
  const { blueprintFromManifest, serializeBlueprint } = await import(
    './blueprint'
  )
  const blueprint = blueprintFromManifest({
    manifest: {
      version: 4,
      database: { dialect: 'sqlite', migrationsDirectory: './migrations', tables: [] },
      storage: {
        defaultBucket: 'media',
        buckets: [{ name: 'media', visibility: 'private' }],
      },
      realtime: { required: false },
      messaging: { channels: [] },
      environment: [],
      api: { operations: [] },
      background: { jobs: [], cron: [], maintenance: [] },
    },
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    worker: { main: 'src/worker.ts', compatibilityDate: '2026-09-28', assets: 'public' },
  })
  const output: string[] = []
  const errors: string[] = []
  const io = { stdout: (m: string) => output.push(m), stderr: (m: string) => errors.push(m) }
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@acme/My App' }))
    await writeFile(join(dir, 'src/bunderstack.ts'), "throw new Error('app code loaded')\n")
    expect(await runCli(['wrangler', dir], io)).toBe(1)
    expect(errors.join('\n')).toContain('run `bunderstack blueprint`')

    await writeFile(join(dir, 'bunderstack.blueprint.yaml'), serializeBlueprint(blueprint))
    errors.length = 0
    expect(await runCli(['wrangler', dir], io), errors.join('\n')).toBe(0)
    expect(await runCli(['wrangler', dir], io)).toBe(0)
    expect(output.slice(-2)).toEqual(['Generated wrangler.json', 'wrangler.json is current'])
    const config = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'))
    expect(config.name).toBe('my-app')
    expect(config.compatibility_date).toBe('2026-09-28')
    expect(config.assets.directory).toBe('public')
    expect(config.r2_buckets).toEqual([{ binding: 'BUCKET_MEDIA', bucket_name: 'my-app-media' }])

    expect(await runCli(['wrangler', dir, '--check'], io)).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

Adjust imports at the top of `cli.test.ts` (`mkdir`, `readFile`, `rm`, `writeFile`, `tmpdir`, `join`) to what the file already imports; add any missing ones.

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/bunderstack && bun test src/workers/wrangler.test.ts src/cli.test.ts`
Expected: FAIL — `toWranglerConfig` is not exported; the CLI still imports the backend.

- [ ] **Step 4: Implement**

Replace everything in `packages/bunderstack/src/workers/wrangler.ts` above `loadBackend` with:

```ts
// src/workers/wrangler.ts — wrangler.json rendered from the committed
// blueprint. The file is a local artifact (git-ignored): `celld dev`, a manual
// `wrangler deploy`, or `celld deploy` read it. Hosts render their own config
// from the same WorkerPlan.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { WorkerPlan } from '../worker-plan'

import { isBunderstackBackend } from '../backend'
import { parseWorkerBlueprintYaml } from '../blueprint'
import { workerPlanFromBlueprint } from '../worker-plan'

export type WranglerConfig = ReturnType<typeof toWranglerConfig>

export function toWranglerConfig(
  plan: WorkerPlan,
  names: { name: string; bucketName: (logical: string) => string },
) {
  return {
    name: names.name,
    main: plan.main,
    compatibility_date: plan.compatibilityDate,
    compatibility_flags: [...plan.compatibilityFlags],
    durable_objects: {
      bindings: plan.durableObjects.bindings.map((binding) => ({
        name: binding.name,
        class_name: binding.className,
      })),
    },
    migrations: plan.durableObjects.migrations.map((migration) => ({
      tag: migration.tag,
      new_sqlite_classes: [...migration.newSqliteClasses],
    })),
    r2_buckets: plan.buckets.map((bucket) => ({
      binding: bucket.binding,
      bucket_name: names.bucketName(bucket.name),
    })),
    assets: {
      directory: plan.assets.directory,
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: [...plan.assets.runWorkerFirst],
    },
    ...(plan.crons.length > 0 ? { triggers: { crons: [...plan.crons] } } : {}),
  }
}

/** A Worker name from package.json#name: no scope, lowercase, [a-z0-9-]. */
export function workerName(packageName: string | undefined): string {
  return (packageName ?? 'app')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
}
```

Keep `loadBackend` exactly as it is (it now needs only `isBunderstackBackend`, `pathToFileURL`, `join`, `readFile`; drop the now-unused `BACKEND_INTERNALS`, `createEnvProbeSources`, and `BunderstackManifest` imports).

Replace `runWranglerCommand` with:

```ts
export async function runWranglerCommand(options: {
  directory: string
  name?: string
  output?: string
}): Promise<{ path: string; changed: boolean }> {
  const directory = resolve(options.directory)
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  ) as { name?: string }
  let source: string
  try {
    source = await readFile(join(directory, 'bunderstack.blueprint.yaml'), 'utf8')
  } catch {
    throw new Error(
      '[bunderstack] bunderstack.blueprint.yaml does not exist; run `bunderstack blueprint`',
    )
  }
  const plan = workerPlanFromBlueprint(parseWorkerBlueprintYaml(source))
  const name = workerName(options.name ?? pkg.name)
  const config = toWranglerConfig(plan, {
    name,
    bucketName: (bucket) => `${name}-${bucket}`,
  })
  const path = join(directory, options.output ?? 'wrangler.json')
  const text = `${JSON.stringify(config, null, 2)}\n`
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  if (existing === text) return { path, changed: false }
  await writeFile(path, text)
  return { path, changed: true }
}
```

In `packages/bunderstack/src/cli.ts`:
- Help line: `bunderstack wrangler [directory] [--name <name>] [--output <path>]`.
- Help text for `wrangler`: `Write wrangler.json for celld dev and manual deploys from bunderstack.blueprint.yaml. The file is generated; do not commit it.`
- Help text for `dev`: replace "regenerates wrangler.json and bunderstack.blueprint.yaml" with "regenerates bunderstack.blueprint.yaml and wrangler.json".
- Help text for `build`: `Check that bunderstack.blueprint.yaml is current, write wrangler.json from it, and build the SPA into dist/client with Vite.`
- In the `wrangler` branch: the options type becomes `{ directory: string; name?: string; output?: string }`; `valued` becomes `{ '--name': 'name', '--output': 'output' } as const`; delete the `--check` branch so `--check` hits the generic `unknown option` path (exit 2).

- [ ] **Step 5: Run the tests**

Run: `cd packages/bunderstack && bun test src/workers/wrangler.test.ts src/cli.test.ts src/worker-plan.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bunx oxfmt packages/bunderstack/src/workers/wrangler.ts packages/bunderstack/src/workers/wrangler.test.ts packages/bunderstack/src/cli.ts packages/bunderstack/src/cli.test.ts
git add packages/bunderstack/src/workers/wrangler.ts packages/bunderstack/src/workers/wrangler.test.ts packages/bunderstack/src/cli.ts packages/bunderstack/src/cli.test.ts
git commit -m "feat(workers)!: render wrangler.json from the blueprint, drop wrangler --check"
```

---

### Task 4: The generator writes version 2 and keeps Worker settings

**Files:**
- Modify: `packages/bunderstack/src/blueprint-generator.ts`
- Modify: `packages/bunderstack/src/blueprint-generator.test.ts`

**Interfaces:**
- Consumes: `blueprintFromManifest({ ..., worker })`, `WorkerSettings` (Task 1).
- Produces: `GenerateBlueprintOptions` gains `today?: string` (tests only; default `new Date().toISOString().slice(0, 10)`). `GenerateBlueprintResult.blueprint` is `WorkerBlueprint`.

Worker settings resolution, first hit wins per key:
1. `application.worker.<key>` in the existing blueprint (raw YAML, any version, even if it fails validation);
2. from an existing `wrangler.json` in the same directory: `compatibility_date`, `main`, `assets.directory` (migration path for beta.1/beta.2 apps);
3. defaults `src/worker.ts`, `today`, `dist/client`.

- [ ] **Step 1: Write the failing tests**

In `packages/bunderstack/src/blueprint-generator.test.ts`:

1. In `fixture()`, change `scripts` to `{ build: 'vite build' }` (no `start`, no `worker`); the fixture's `jobs` must no longer demand a `worker` script.
2. Delete the test `'generateBlueprint emits a worker blueprint when package.json has no start script and never serializes secret…'` and move its "never serializes secret values" assertions into the new test below if they are not covered elsewhere (read the deleted test first and carry over every `expect(...).not.toContain(...)` it has).
3. Append:

```ts
test('generateBlueprint writes version 2 with default Worker settings', async () => {
  const directory = await fixture()
  try {
    const result = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(result.blueprint.version).toBe(2)
    expect(result.blueprint.application.worker).toEqual({
      main: 'src/worker.ts',
      compatibilityDate: '2026-09-29',
      assets: 'dist/client',
    })
    expect(result.source).not.toContain('start:')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint keeps Worker settings from the committed blueprint', async () => {
  const directory = await fixture()
  try {
    const first = await generateBlueprint({ directory, today: '2026-09-29' })
    const edited = first.source
      .replace('main: src/worker.ts', 'main: src/entry/worker.ts')
      .replace('assets: dist/client', 'assets: public')
    await Bun.write(join(directory, 'bunderstack.blueprint.yaml'), edited)
    const later = await generateBlueprint({ directory, today: '2030-01-01' })
    expect(later.changed).toBe(false)
    expect(later.blueprint.application.worker).toEqual({
      main: 'src/entry/worker.ts',
      compatibilityDate: '2026-09-29',
      assets: 'public',
    })
    await expect(
      generateBlueprint({ directory, check: true, today: '2030-01-01' }),
    ).resolves.toMatchObject({ changed: false })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint adopts compatibility_date and assets from an old wrangler.json', async () => {
  const directory = await fixture()
  try {
    await Bun.write(
      join(directory, 'wrangler.json'),
      JSON.stringify({
        main: 'src/worker.ts',
        compatibility_date: '2026-09-01',
        assets: { directory: 'public' },
      }),
    )
    const result = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(result.blueprint.application.worker).toEqual({
      main: 'src/worker.ts',
      compatibilityDate: '2026-09-01',
      assets: 'public',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generateBlueprint replaces a version 1 blueprint with version 2', async () => {
  const directory = await fixture()
  try {
    await Bun.write(
      join(directory, 'bunderstack.blueprint.yaml'),
      'version: 1\napplication:\n  runtime: worker\n',
    )
    await expect(
      generateBlueprint({ directory, check: true }),
    ).rejects.toBeInstanceOf(BlueprintCheckError)
    const result = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(result.changed).toBe(true)
    expect(result.blueprint.version).toBe(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/bunderstack && bun test src/blueprint-generator.test.ts`
Expected: FAIL — `today` is ignored and settings are not preserved (the Task 1 bridge always uses today's defaults).

- [ ] **Step 3: Implement**

In `packages/bunderstack/src/blueprint-generator.ts`:

1. Import `parse` from `yaml` and `type WorkerSettings` from `./blueprint`.
2. Add `today?: string` to `GenerateBlueprintOptions` with the comment `/** UTC date for a new compatibilityDate; tests pin it. */`.
3. Change `requireScript`'s `name` parameter type to `'build'` and delete the `hasStartScript` line and the `if (hasStartScript) requireScript(pkg, 'worker', ...)` block.
4. Add:

```ts
async function readText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined)
}

/**
 * Worker settings survive regeneration: the committed blueprint wins, then an
 * old wrangler.json (apps from beta.1 and beta.2), then the defaults.
 */
async function workerSettings(
  directory: string,
  existing: string | undefined,
  today: string,
): Promise<WorkerSettings> {
  let fromBlueprint: Partial<WorkerSettings> = {}
  try {
    const raw = parse(existing ?? '') as {
      application?: { worker?: Partial<WorkerSettings> }
    } | null
    fromBlueprint = raw?.application?.worker ?? {}
  } catch {}
  let fromWrangler: Partial<WorkerSettings> = {}
  try {
    const raw = JSON.parse(
      (await readText(join(directory, 'wrangler.json'))) ?? 'null',
    ) as {
      main?: string
      compatibility_date?: string
      assets?: { directory?: string }
    } | null
    fromWrangler = {
      main: raw?.main,
      compatibilityDate: raw?.compatibility_date,
      assets: raw?.assets?.directory,
    }
  } catch {}
  const pick = (key: keyof WorkerSettings, fallback: string) => {
    const value = fromBlueprint[key] ?? fromWrangler[key]
    return typeof value === 'string' && value ? value : fallback
  }
  return {
    main: pick('main', 'src/worker.ts'),
    compatibilityDate: pick('compatibilityDate', today),
    assets: pick('assets', 'dist/client'),
  }
}
```

5. Move the read of the existing output file above `blueprintFromManifest`, replacing the two `Bun.file(outputPath)` calls:

```ts
  const existing = await readText(outputPath)
  const blueprint = blueprintFromManifest({
    manifest: { ...manifest, database: { ...manifest.database, migrationsDirectory } },
    generatorVersion: await packageVersion(),
    entry,
    migrationMode,
    framework,
    worker: await workerSettings(
      directory,
      existing,
      options.today ?? new Date().toISOString().slice(0, 10),
    ),
  })
  const source = serializeBlueprint(blueprint)
```

and delete the old `const existing = (await Bun.file(outputPath).exists()) ? ... : undefined`. Remove the Task 1 bridge.

6. Change `GenerateBlueprintResult.blueprint` to `WorkerBlueprint`. The `hostedCheck` branch returns `parseBlueprintYaml(source)`, which is the union; change it to `parseWorkerBlueprintYaml(source)`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/bunderstack && bun test src/blueprint-generator.test.ts src/blueprint.test.ts src/hosted-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts
git add packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts
git commit -m "feat(blueprint): generate version 2 and keep Worker settings across runs"
```

---

### Task 5: `dev` and `build` put the blueprint first

**Files:**
- Modify: `packages/bunderstack/src/dev/push.ts`
- Modify: `packages/bunderstack/src/dev/index.ts` (header comment, `runBuild`)
- Modify: `packages/bunderstack/src/dev/index.test.ts:94-126`

**Interfaces:**
- Consumes: `generateBlueprint` (Task 4), `runWranglerCommand` (Task 3).
- Produces: `runBuild({ directory }): Promise<number>` — returns 1 on a missing or stale blueprint without running Vite; otherwise writes `wrangler.json`, runs `vite build` when a Vite config exists, returns its status.

- [ ] **Step 1: Rewrite the build test**

Replace the test `'runBuild checks both wrangler.json and bunderstack.blueprint.yaml'` in `packages/bunderstack/src/dev/index.test.ts` with the same fixture setup and this body (drop the `runWranglerCommand` import if it becomes unused):

```ts
  try {
    // No blueprint: build fails and writes nothing.
    expect(await runBuild({ directory })).toBe(1)
    expect(await Bun.file(join(directory, 'wrangler.json')).exists()).toBe(false)

    await generateBlueprint({ directory })
    expect(await runBuild({ directory })).toBe(0)
    const config = JSON.parse(await readFile(join(directory, 'wrangler.json'), 'utf8'))
    expect(config.name).toBe('probe-worker')

    // A stale blueprint fails, and build does not rewrite it.
    await writeFile(join(directory, 'bunderstack.blueprint.yaml'), 'stale\n')
    expect(await runBuild({ directory })).toBe(1)
    expect(await readFile(join(directory, 'bunderstack.blueprint.yaml'), 'utf8')).toBe('stale\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
```

Rename the test to `'runBuild requires a current blueprint and writes wrangler.json from it'`. Add `readFile` to the `node:fs/promises` import if missing.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/bunderstack && bun test src/dev/index.test.ts`
Expected: FAIL — after `generateBlueprint`, `runBuild` does not write `wrangler.json`.

- [ ] **Step 3: Implement**

`packages/bunderstack/src/dev/index.ts`, replace `runBuild`:

```ts
export async function runBuild(options: {
  directory: string
}): Promise<number> {
  const directory = resolve(options.directory)
  try {
    await generateBlueprint({ directory, check: true })
    console.log('bunderstack.blueprint.yaml is current')
    await runWranglerCommand({ directory })
    console.log('wrote wrangler.json')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (await hasViteConfig(directory)) {
    const vite = Bun.spawn([process.execPath, 'x', '--bun', 'vite', 'build'], {
      cwd: directory,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await vite.exited) !== 0) return 1
  }
  return 0
}
```

Header comment (lines 1-3): `// \`bunderstack dev\` and \`bunderstack build\`. dev starts sqld, celld, and Vite with one command; build checks bunderstack.blueprint.yaml, writes wrangler.json from it, and writes the SPA to dist/client.`
Change the comment `// The first push also writes wrangler.json, which celld reads at start.` to `// The first push writes the blueprint and wrangler.json; celld reads the latter at start.`

`packages/bunderstack/src/dev/push.ts`: swap the two generation blocks so the blueprint comes first, and update the header comment to "regenerates bunderstack.blueprint.yaml and wrangler.json from it":

```ts
const blueprint = await generateBlueprint({ directory })
if (blueprint.changed) console.log('bunderstack.blueprint.yaml updated')

const wrangler = await runWranglerCommand({ directory })
if (wrangler.changed) console.log('wrangler.json updated')
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/bunderstack && bun test src/dev src/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt packages/bunderstack/src/dev/index.ts packages/bunderstack/src/dev/index.test.ts packages/bunderstack/src/dev/push.ts
git add packages/bunderstack/src/dev
git commit -m "feat(dev): generate the blueprint first; build checks it and writes wrangler.json"
```

---

### Task 6: Worker examples commit only the blueprint

**Files:**
- Modify: `examples/todo-solid-native/{.gitignore,bunderstack.blueprint.yaml}`, delete `examples/todo-solid-native/wrangler.json`
- Modify: `examples/agent-chat/{.gitignore,bunderstack.blueprint.yaml}`, delete `examples/agent-chat/wrangler.json`
- Create: `examples/workers-probe/bunderstack.blueprint.yaml`; modify `examples/workers-probe/{.gitignore,package.json}`; delete `examples/workers-probe/wrangler.json`
- Modify: `scripts/workers-integration.ts`

**Interfaces:**
- Consumes: the CLI from Tasks 3–5 via `bun ../../packages/bunderstack/src/cli.ts`.

- [ ] **Step 1: Generate version 2 blueprints while the old wrangler.json still exists**

The generator adopts `compatibility_date` and `assets.directory` from the committed `wrangler.json` (Task 4), so run it before deleting that file.

```bash
cd examples/workers-probe && node -e "const p=require('./package.json');p.scripts.build='bunderstack build';p.scripts.wrangler='bun ../../packages/bunderstack/src/cli.ts wrangler .';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" && bun ../../packages/bunderstack/src/cli.ts blueprint . && cd ../..
cd examples/todo-solid-native && bun ../../packages/bunderstack/src/cli.ts blueprint . && cd ../..
cd examples/agent-chat && bun ../../packages/bunderstack/src/cli.ts blueprint . && cd ../..
```

Expected: each prints `Generated bunderstack.blueprint.yaml`. Check each file starts with `version: 2`, has `application.worker`, and that `workers-probe` has `assets: public` and its old `compatibility_date`.

- [ ] **Step 2: Remove the committed wrangler.json and ignore it**

```bash
for app in todo-solid-native agent-chat workers-probe; do
  git rm -q examples/$app/wrangler.json
  printf 'wrangler.json\n' >> examples/$app/.gitignore
done
```

- [ ] **Step 3: Generate the probe's wrangler.json in the integration script**

In `scripts/workers-integration.ts`, before the first use of `join(probe, 'wrangler.json')` and before starting celld or wrangler, add:

```ts
  // wrangler.json is generated from the committed blueprint, as in `bunderstack dev`.
  const { runWranglerCommand } = await import(
    '../packages/bunderstack/src/workers/wrangler'
  )
  await runWranglerCommand({ directory: probe })
```

Put it in the same async scope as the other setup (next to the migrations block around line 107).

- [ ] **Step 4: Verify**

Run: `bun run test:workers`
Expected: PASS on celld. Then `bun run test:workers -- --runtime workerd`; expected PASS. If either fails for a reason unrelated to this change (download or port issues), record the output and continue; do not change runtime code in this task.
Run: `bun run typecheck:examples`
Expected: PASS.
Run: `cd examples/todo-solid-native && bun ../../packages/bunderstack/src/cli.ts build . ; cd ../..`
Expected: `bunderstack.blueprint.yaml is current`, `wrote wrangler.json`, Vite build succeeds; `git status` shows no change to tracked files.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt scripts/workers-integration.ts examples/workers-probe/package.json
git add examples/todo-solid-native examples/agent-chat examples/workers-probe scripts/workers-integration.ts
git commit -m "chore(examples): commit only the blueprint; wrangler.json is generated"
```

---

### Task 7: Delete the SaaS template

**Files:**
- Delete: `templates/tanstack-start-saas/` (whole directory); `templates/` if it is then empty
- Delete: `scripts/template-contract.test.ts`
- Modify: `scripts/skills-contract.test.ts:23`
- Modify: `.agents/skills/creating-bunderstack-apps/SKILL.md` (lines 12, 22 and any other template mention)
- Modify: `packages/bunderstack/llms-full.txt` (line 744 link, the section starting at line 3165)
- Modify: root `package.json` (`workspaces`, any script that mentions the template), `bun.lock`

- [ ] **Step 1: Find every live reference**

Run: `git grep -n "tanstack-start-saas\|templates/" -- ':!docs' ':!**/CHANGELOG.md'`
Historical files under `docs/` stay unchanged. Every other hit is handled in the next steps.

- [ ] **Step 2: Delete and edit**

```bash
git rm -rq templates/tanstack-start-saas scripts/template-contract.test.ts
```

- Root `package.json`: remove `"templates/*"` from `workspaces` (if `templates/` has no other child) and any script naming the template.
- `scripts/skills-contract.test.ts`: delete the assertion that the skill mentions `templates/tanstack-start-saas`. If the whole test only checks the template, delete that test.
- `.agents/skills/creating-bunderstack-apps/SKILL.md`: remove the "Full SaaS — copy `templates/tanstack-start-saas/`" step and table row. Where the skill needs a starting point for a new app, point to `examples/todo-solid-native` as the 1.0 Worker SPA reference and add one line: `A 1.0 SaaS template is not available yet.`
- `packages/bunderstack/llms-full.txt`: delete the `## BunderSaaS Template (templates/tanstack-start-saas)` section up to the next `## ` heading, and replace the link at line 744 with a link to `examples/todo-solid-native/src/bunderstack.ts` on the `next` branch.
- If a skills copy ships inside the package (`packages/bunderstack/skills/`), apply the same SKILL.md change there; `bun test scripts/skills-contract.test.ts` tells you whether the copies must match.

- [ ] **Step 3: Refresh the lockfile and verify**

Run: `bun install`
Run: `git grep -n "tanstack-start-saas" -- ':!docs' ':!**/CHANGELOG.md'`
Expected: no output.
Run: `bun test scripts/`
Expected: PASS (minus the baseline failures from Task 1 Step 1, if any were in `scripts/`).

- [ ] **Step 4: Commit**

```bash
git add -A templates scripts .agents packages/bunderstack/llms-full.txt packages/bunderstack/skills package.json bun.lock
git commit -m "chore!: delete the 0.x SaaS template"
```

---

### Task 8: Release notes and beta.3

**Files:**
- Modify: `packages/bunderstack/CHANGELOG.md`, `CHANGELOG.md` (root, same entry), `packages/bunderstack/package.json` (`version`)

- [ ] **Step 1: Write the changelog entry**

Add above `## [1.0.0-beta.2]` in both changelogs:

```markdown
## [1.0.0-beta.3] — 2026-09-29

### Changed

- `bunderstack.blueprint.yaml` is the only committed deploy contract. 1.0
  writes `version: 2` with `application.worker` (`main`, `compatibilityDate`,
  `assets`); the generator keeps these values once set and adopts them from an
  existing `wrangler.json` on the first run.
- `wrangler.json` is generated from the blueprint by `bunderstack dev`,
  `bunderstack build`, and `bunderstack wrangler`. Add it to `.gitignore`.
- `bunderstack build` fails on a missing or stale blueprint before building,
  and writes `wrangler.json` for a manual `wrangler deploy` or `celld deploy`.
- `bunderstack wrangler` reads the blueprint and no longer imports app code.

### Added

- `workerPlanFromBlueprint(blueprint)` and `WorkerPlan` in `bunderstack/blueprint`
  and `bunderstack/workers`: what a host needs to deploy the Worker, without
  physical names.
- `parseWorkerBlueprint` and `parseWorkerBlueprintYaml`.

### Removed

- `application.runtime` from beta.2. A version 1 blueprint with
  `runtime: worker` fails; regenerate it.
- `bunderstack wrangler --check`, `--entry`, and `--assets`.
- `buildWranglerConfig` and `WranglerCheckError`.
- The `templates/tanstack-start-saas` template.

### Migration

Run `bunderstack dev` or `bunderstack blueprint` once, commit
`bunderstack.blueprint.yaml`, delete `wrangler.json` from git, and add it to
`.gitignore`.
```

Set `"version": "1.0.0-beta.3"` in `packages/bunderstack/package.json`.

- [ ] **Step 2: Full verification**

Run each and compare with the Task 1 baseline:

```bash
bun run test
bun run typecheck:all
bun run test:boundaries
bun run test:bundles
bun run test:workers
```

Expected: no new failures. Record the exact counts in the commit message body.

- [ ] **Step 3: Commit**

```bash
git add packages/bunderstack/CHANGELOG.md CHANGELOG.md packages/bunderstack/package.json
git commit -m "release: bunderstack 1.0.0-beta.3"
```

- [ ] **Step 4: Publish (needs the user)**

Stop and ask the user before pushing: publishing is outward-facing. Once they confirm, push `next` (`git push origin next`); the publish workflow (`.github/workflows/publish.yml` → `scripts/publish-changed.ts`) publishes the prerelease with the `next` tag. Verify with `npm view bunderstack@next version` → `1.0.0-beta.3`.
