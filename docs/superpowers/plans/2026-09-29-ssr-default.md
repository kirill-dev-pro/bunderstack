# SSR by default (bunderstack beta.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 1.0 app runs TanStack Start with SSR (or an SPA) on the Workers runtime without writing any Worker code; `bunderstack dev` runs it in workerd through the Cloudflare Vite plugin, and `bunderstack build` produces one artifact shape for hosts.

**Architecture:** The blueprint's `application.worker` gains `render: ssr | spa` and `main` may name a package entry. Two package entries (`bunderstack/start/server-entry`, `bunderstack/workers/entry`) import the app backend through the Vite virtual module `virtual:bunderstack/backend`, create the bunderstack Worker once per isolate, register it, and export the Durable Objects. The `bunderstack()` Vite plugin wires `@cloudflare/vite-plugin` (and `tanstackStart()` for SSR) and resolves the virtual module. The existing isomorphic fetch in `bunderstack/start` calls the registered Worker in the isolate on the server.

**Tech Stack:** Bun, TypeScript, Vite 8, `@cloudflare/vite-plugin` ^1.62, `@tanstack/react-start` ^1.168, workerd, celld 0.6, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-29-ssr-default-design.md`

## Global Constraints

- Work in `/Users/kirill/Projects/bunderstack-project/bunderstack/.claude/worktrees/next`. Never change `main`.
- Release `1.0.0-beta.4`, published by pushing `next` (the workflow publishes with dist-tag `beta`). Ask the user before pushing.
- SSR framework: TanStack Start with React only.
- Package entries, exact strings: `bunderstack/start/server-entry` (SSR), `bunderstack/workers/entry` (SPA). Virtual module: `virtual:bunderstack/backend`.
- Artifact, both modes: `dist/server/index.js` and `dist/client`.
- `notFoundHandling`: `none` for `ssr`, `single-page-application` for `spa`.
- `bunderstack dev` does not start celld. `.dev.vars` `APP_URL` uses `localhost`.
- `bunderstack build` deletes `dist/client/.assetsignore` and every `.dev.vars` under `dist/` (spec deviation: the Cloudflare plugin copies the local `.dev.vars` into `dist/server/` on every build, so failing would break every local build; hosts refuse the file instead).
- Format touched files with the stdin helper: `oxfmt` skips this worktree because it sits under a git-ignored path of the main checkout. Helper: `for f in FILES; do out=$(bunx oxfmt -c .oxfmtrc.json --stdin-filepath="$f" < "$f") && printf '%s\n' "$out" > "$f"; done` (run from the worktree root; in zsh pass files as an array).
- Typecheck with both configs: `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json` and `bunx tsc --noEmit -p packages/bunderstack/tsconfig.build.json`.
- `bun run test:workers` needs `CELLD_BIN=~/.cache/bunderstack/celld-v0.6.0-aarch64-apple-darwin/celld` and `SQLD_BIN=$(ls -d ~/.cache/bunderstack/sqld-v0.24.32-aarch64-apple-darwin/*/sqld)` on this machine.
- Baseline before Task 1: package tests 833 pass / 0 fail; scripts 67 / 0.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files by name; never `git add -A` over the tree.

---

### Task 1: Contract — `render`, `main` forms, `WorkerPlan.artifact`

**Files:**
- Modify: `packages/bunderstack/src/blueprint.ts` (WorkerSettings, worker schema, messages)
- Modify: `packages/bunderstack/src/worker-plan.ts`
- Modify: `packages/bunderstack/src/workers/wrangler.ts` (`toWranglerConfig` reads `assets.notFoundHandling`; new `artifact` option)
- Modify: `packages/bunderstack/src/blueprint-generator.ts` (defaults for `render` and `main`)
- Test: `packages/bunderstack/src/blueprint.test.ts`, `src/worker-plan.test.ts`, `src/workers/wrangler.test.ts`, `src/blueprint-generator.test.ts`, `src/backend.test.ts` (fixture), `src/cli.test.ts` (fixture)

**Interfaces:**
- Produces:

```ts
// blueprint.ts
export const WORKER_PACKAGE_ENTRIES = [
  'bunderstack/start/server-entry',
  'bunderstack/workers/entry',
] as const
export type WorkerRender = 'ssr' | 'spa'
export type WorkerSettings = {
  render: WorkerRender
  main: string // relative path or one of WORKER_PACKAGE_ENTRIES
  compatibilityDate: string
  assets: string
}

// worker-plan.ts
export type WorkerPlan = {
  render: WorkerRender
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: { bindings: { name: string; className: string }[]; migrations: { tag: string; newSqliteClasses: string[] }[] }
  buckets: { name: string; binding: string }[]
  crons: string[]
  assets: {
    directory: string
    notFoundHandling: 'none' | 'single-page-application'
    runWorkerFirst: string[]
  }
  artifact: { main: 'dist/server/index.js'; assets: string; modules: true }
}

// wrangler.ts
export function toWranglerConfig(
  plan: WorkerPlan,
  names: { name: string; bucketName: (logical: string) => string },
  options?: { artifact?: boolean }, // true: main/assets from plan.artifact
): WranglerConfig

// blueprint-generator.ts — GenerateBlueprintOptions unchanged; defaults below
```

- [ ] **Step 1: Baseline**

Run: `cd packages/bunderstack && bun test 2>&1 | tail -3` — expect 833 pass / 0 fail. Record it.

- [ ] **Step 2: Write failing blueprint tests**

In `packages/bunderstack/src/blueprint.test.ts`, change the shared constant to

```ts
const WORKER = {
  render: 'spa' as const,
  main: 'src/worker.ts',
  compatibilityDate: '2026-09-28',
  assets: 'dist/client',
}
```

and append:

```ts
test('version 2 requires render and accepts ssr and spa', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.4',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: { ...WORKER, render: 'ssr', main: 'bunderstack/start/server-entry' },
  })
  expect(blueprint.application.worker.render).toBe('ssr')
  const { render: _render, ...withoutRender } = blueprint.application.worker
  expect(() =>
    parseBlueprint({
      ...blueprint,
      application: { ...blueprint.application, worker: withoutRender },
    }),
  ).toThrow(/regenerate the blueprint with bunderstack 1.0.0-beta.4/)
  expect(() =>
    parseBlueprint({
      ...blueprint,
      application: {
        ...blueprint.application,
        worker: { ...blueprint.application.worker, render: 'isr' },
      },
    }),
  ).toThrow()
})

test('main is a relative path or a known package entry', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.4',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: WORKER,
  })
  const withMain = (main: string) => ({
    ...blueprint,
    application: {
      ...blueprint.application,
      worker: { ...blueprint.application.worker, main },
    },
  })
  for (const main of [
    'src/server.ts',
    'bunderstack/start/server-entry',
    'bunderstack/workers/entry',
  ]) {
    expect(parseBlueprint(withMain(main)).version).toBe(2)
  }
  for (const main of ['bunderstack/other', '@acme/entry', '../x.ts', '/abs.ts']) {
    expect(() => parseBlueprint(withMain(main))).toThrow()
  }
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/bunderstack && bun test src/blueprint.test.ts`
Expected: FAIL (`render` unknown; package entries rejected by `relativePath`).

- [ ] **Step 4: Implement the schema**

In `blueprint.ts`:

```ts
export const WORKER_PACKAGE_ENTRIES = [
  'bunderstack/start/server-entry',
  'bunderstack/workers/entry',
] as const
export type WorkerRender = 'ssr' | 'spa'

export type WorkerSettings = {
  render: WorkerRender
  main: string
  compatibilityDate: string
  assets: string
}

const workerMain = v.union([
  v.picklist(WORKER_PACKAGE_ENTRIES),
  relativePath,
])
```

`relativePath` already rejects a leading `/` and `..`; it would accept `bunderstack/other` and `@acme/entry` as relative paths. Tighten `workerMain` so a value that starts with `bunderstack/` or `@` must be a package entry:

```ts
const workerMain = v.pipe(
  nonEmpty,
  v.check(
    (value) =>
      (WORKER_PACKAGE_ENTRIES as readonly string[]).includes(value) ||
      (!value.startsWith('bunderstack/') &&
        !value.startsWith('@') &&
        !value.startsWith('/') &&
        !value.includes('\\') &&
        value.split('/').every((part) => part !== '' && part !== '..')),
    'main must be a relative path inside the package or a bunderstack entry',
  ),
)
```

Change the worker schema to

```ts
    worker: open({
      render: v.picklist(['ssr', 'spa']),
      main: workerMain,
      compatibilityDate,
      assets: relativePath,
    }),
```

In `parseBlueprint`, next to the beta.2 `runtime: worker` pre-check, add:

```ts
  const worker = (value as {
    version?: unknown
    application?: { worker?: { render?: unknown } }
  } | null)?.application?.worker
  if (
    (value as { version?: unknown } | null)?.version === 2 &&
    worker &&
    worker.render === undefined
  ) {
    throw new Error(
      '[bunderstack] application.worker.render is missing; regenerate the blueprint with bunderstack 1.0.0-beta.4',
    )
  }
```

- [ ] **Step 5: Plan and wrangler tests**

In `packages/bunderstack/src/worker-plan.test.ts`, add `render: 'spa'` to the helper's `worker` settings, change the first test's expected `assets` to

```ts
    assets: {
      directory: 'dist/client',
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*', '/webhooks/*'],
    },
    artifact: {
      main: 'dist/server/index.js',
      assets: 'dist/client',
      modules: true,
    },
```

and add `render: 'spa'` at the top of that expected object. Append:

```ts
test('ssr sends every path without a file to the Worker', () => {
  const source = blueprint()
  const plan = workerPlanFromBlueprint({
    ...source,
    application: {
      ...source.application,
      worker: {
        ...source.application.worker,
        render: 'ssr',
        main: 'bunderstack/start/server-entry',
      },
    },
  })
  expect(plan.render).toBe('ssr')
  expect(plan.main).toBe('bunderstack/start/server-entry')
  expect(plan.assets.notFoundHandling).toBe('none')
  expect(plan.assets.runWorkerFirst).toEqual([])
  expect(plan.artifact.main).toBe('dist/server/index.js')
})
```

In `packages/bunderstack/src/workers/wrangler.test.ts`, give the `plan` constant `render: 'spa'`, `assets.notFoundHandling: 'single-page-application'`, and `artifact: { main: 'dist/server/index.js', assets: 'dist/client', modules: true }`. Append:

```ts
test('the artifact form points at the built Worker and asset directory', () => {
  const config = toWranglerConfig(
    {
      ...plan,
      render: 'ssr',
      main: 'bunderstack/start/server-entry',
      assets: { directory: 'dist/client', notFoundHandling: 'none', runWorkerFirst: [] },
    },
    { name: 'app', bucketName: (bucket) => `app-${bucket}` },
    { artifact: true },
  )
  expect(config.main).toBe('dist/server/index.js')
  expect(config.assets).toEqual({
    directory: 'dist/client',
    binding: 'ASSETS',
    not_found_handling: 'none',
  })
})

test('the source form keeps the package entry as main', () => {
  const config = toWranglerConfig(
    { ...plan, main: 'bunderstack/workers/entry' },
    { name: 'app', bucketName: (bucket) => bucket },
  )
  expect(config.main).toBe('bunderstack/workers/entry')
  expect(config.assets.run_worker_first).toEqual(['/api/*', '/webhooks/*'])
})
```

- [ ] **Step 6: Implement plan and wrangler**

`worker-plan.ts` — return:

```ts
  const ssr = worker.render === 'ssr'
  return {
    render: worker.render,
    main: worker.main,
    compatibilityDate: worker.compatibilityDate,
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { /* unchanged */ },
    buckets: /* unchanged */,
    crons: crons.length > MAX_CRONS ? ['* * * * *'] : crons,
    assets: {
      directory: worker.assets,
      notFoundHandling: ssr ? 'none' : 'single-page-application',
      // SSR: a path without a file already reaches the Worker.
      runWorkerFirst: ssr ? [] : runWorkerFirst,
    },
    artifact: { main: 'dist/server/index.js', assets: worker.assets, modules: true },
  }
```

Import `type WorkerRender` from `./blueprint` for the plan type.

`wrangler.ts` — `toWranglerConfig(plan, names, options = {})`:

```ts
  const main = options.artifact ? plan.artifact.main : plan.main
  const directory = options.artifact ? plan.artifact.assets : plan.assets.directory
  ...
    main,
    ...
    assets: {
      directory,
      binding: 'ASSETS',
      not_found_handling: plan.assets.notFoundHandling,
      ...(plan.assets.runWorkerFirst.length > 0
        ? { run_worker_first: [...plan.assets.runWorkerFirst] }
        : {}),
    },
```

- [ ] **Step 7: Generator defaults and tests**

In `blueprint-generator.ts`, `workerSettings()` gains the `render` key and resolves `main` after `render`:

```ts
async function workerSettings(
  directory: string,
  existing: string | undefined,
  today: string,
  hasStart: boolean,
): Promise<WorkerSettings> {
  // ...existing fromBlueprint / fromWrangler reads...
  const render: WorkerRender =
    fromBlueprint.render === 'ssr' || fromBlueprint.render === 'spa'
      ? fromBlueprint.render
      : hasStart
        ? 'ssr'
        : 'spa'
  const customEntry = await exists(join(directory, 'src/server.ts'))
  const defaultMain = customEntry
    ? 'src/server.ts'
    : render === 'ssr'
      ? 'bunderstack/start/server-entry'
      : 'bunderstack/workers/entry'
  return {
    render,
    main: pick('main', defaultMain),
    compatibilityDate: pick('compatibilityDate', today),
    assets: pick('assets', 'dist/client'),
  }
}
```

`hasStart` is `typeof allDependencies['@tanstack/react-start'] === 'string'` (already computed for `framework`). `exists` is `(path) => stat(path).then(() => true, () => false)` from `node:fs/promises`. `pick` keeps its current behavior; the fallback from an old `wrangler.json` `main` stays, so beta.3 apps with `src/worker.ts` keep it until they delete the file (Task 5 deletes it in the examples and regenerates).

Append to `blueprint-generator.test.ts`:

```ts
test('generateBlueprint picks ssr for a TanStack Start app and spa otherwise', async () => {
  const directory = await fixture()
  try {
    const spa = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(spa.blueprint.application.worker).toMatchObject({
      render: 'spa',
      main: 'bunderstack/workers/entry',
    })
    await rm(join(directory, 'bunderstack.blueprint.yaml'))
    const pkg = JSON.parse(await Bun.file(join(directory, 'package.json')).text())
    pkg.dependencies['@tanstack/react-start'] = '^1.168.0'
    await Bun.write(join(directory, 'package.json'), JSON.stringify(pkg))
    const ssr = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(ssr.blueprint.application.worker).toMatchObject({
      render: 'ssr',
      main: 'bunderstack/start/server-entry',
    })
    await Bun.write(join(directory, 'src/server.ts'), 'export default {}')
    await rm(join(directory, 'bunderstack.blueprint.yaml'))
    const custom = await generateBlueprint({ directory, today: '2026-09-29' })
    expect(custom.blueprint.application.worker.main).toBe('src/server.ts')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

Note: the existing `fixture()` declares `@tanstack/react-start`. Change the fixture's dependencies to `{}` so the default is `spa`, and update the older generator tests in this file that assert `framework: 'tanstack-start'` or a Worker `main` to the values the new defaults produce (`bun-ssr` framework, `bunderstack/workers/entry`); do not weaken unrelated assertions.

Update the `worker` fixtures in `src/backend.test.ts` and `src/cli.test.ts` to include `render: 'spa'` and, for `cli.test.ts`, keep `main: 'src/worker.ts'`.

- [ ] **Step 8: Run tests and typecheck**

```bash
cd packages/bunderstack && bun test src/blueprint.test.ts src/worker-plan.test.ts src/workers src/blueprint-generator.test.ts src/backend.test.ts src/cli.test.ts src/dev
bunx tsc --noEmit -p tsconfig.json && bunx tsc --noEmit -p tsconfig.build.json
```

Expected: PASS and no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/worker-plan.ts packages/bunderstack/src/worker-plan.test.ts packages/bunderstack/src/workers/wrangler.ts packages/bunderstack/src/workers/wrangler.test.ts packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/cli.test.ts
git commit -m "feat(blueprint)!: render mode, package entries, and the build artifact in WorkerPlan"
```

---

### Task 2: Worker registry, package entries, and in-isolate fetch

**Files:**
- Create: `packages/bunderstack/src/workers/registry.ts`, `src/workers/registry.test.ts`
- Create: `packages/bunderstack/src/workers/entry.ts` (SPA package entry)
- Create: `packages/bunderstack/src/start/server-entry.ts` (SSR package entry)
- Create: `packages/bunderstack/src/start/create-start-worker.ts`, `src/start/create-start-worker.test.ts`
- Create: `packages/bunderstack/src/virtual.d.ts` (ambient types for `virtual:bunderstack/backend` and `cloudflare:workers`)
- Modify: `packages/bunderstack/src/workers/index.ts` (register in `createWorker`)
- Modify: `packages/bunderstack/src/start/isomorphic-fetch.ts`, `src/start/isomorphic-fetch.test.ts`
- Modify: `packages/bunderstack/src/start/index.ts` (export `createStartWorker`)
- Modify: `packages/bunderstack/package.json` (exports `./start/server-entry`, `./workers/entry`; optional peer `@cloudflare/vite-plugin`)
- Modify: `scripts/dependency-boundaries.test.ts` if it rejects the new imports (Step 6)

**Interfaces:**
- Consumes: `createWorker(backend)` → `{ handler, durableObjects }` (existing).
- Produces:

```ts
// workers/registry.ts
export type RegisteredWorker = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>
}
export function registerWorker(worker: RegisteredWorker): void
export function registeredWorker(): RegisteredWorker | undefined

// start/create-start-worker.ts
export function createStartWorker(
  backend: BunderstackBackend<any>,
  startHandler?: (request: Request) => Promise<Response>, // default: createStartHandler(defaultStreamHandler)
): {
  handler: { fetch(...): Promise<Response>; scheduled(...): Promise<void> }
  durableObjects: { Scheduler; RealtimeHub; RateLimiter }
}

// start/isomorphic-fetch.ts
export function createIsomorphicFetch(options?: {
  fetch?: typeof fetch
  /** Tests only: env and incoming request for the in-isolate path. */
  isolate?: { env: () => Promise<WorkerEnv>; request: () => Promise<Request> }
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
```

- [ ] **Step 1: Registry test**

`src/workers/registry.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test'

import { registeredWorker, registerWorker, resetRegistryForTests } from './registry'

afterEach(() => resetRegistryForTests())

test('the last registered Worker is returned', () => {
  expect(registeredWorker()).toBeUndefined()
  const worker = { fetch: async () => new Response('ok') }
  registerWorker(worker)
  expect(registeredWorker()).toBe(worker)
})
```

- [ ] **Step 2: Run** — `bun test src/workers/registry.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement registry and register in `createWorker`**

`src/workers/registry.ts`:

```ts
// src/workers/registry.ts — the bunderstack Worker of this isolate. A package
// entry registers it; server-side fetch in Start calls it without a network hop.
import type { ExecutionContextLike, WorkerEnv } from './types'

export type RegisteredWorker = {
  fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContextLike,
  ): Promise<Response>
}

let current: RegisteredWorker | undefined

export function registerWorker(worker: RegisteredWorker): void {
  current = worker
}

export function registeredWorker(): RegisteredWorker | undefined {
  return current
}

export function resetRegistryForTests(): void {
  current = undefined
}
```

In `src/workers/index.ts`, at the end of `createWorker` before `return`, add `registerWorker(handler)` and export `registerWorker, registeredWorker` from `./registry`.

- [ ] **Step 4: Isomorphic fetch tests**

Append to `src/start/isomorphic-fetch.test.ts`:

```ts
import { registerWorker, resetRegistryForTests } from '../workers/registry'

test('on the server a registered Worker is called in the isolate with the cookie', async () => {
  const seen: Request[] = []
  registerWorker({
    async fetch(request) {
      seen.push(request)
      return new Response('in-isolate')
    },
  })
  try {
    const iso = createIsomorphicFetch({
      fetch: async () => new Response('network'),
      isolate: {
        env: async () => ({}),
        request: async () =>
          new Request('https://app.example/boards', {
            headers: { cookie: 'better-auth.session_token=abc' },
          }),
      },
    })
    const res = await iso('/api/notes?limit=1', { headers: { 'x-a': '1' } })
    expect(await res.text()).toBe('in-isolate')
    expect(seen[0]!.url).toBe('https://app.example/api/notes?limit=1')
    expect(seen[0]!.headers.get('cookie')).toBe('better-auth.session_token=abc')
    expect(seen[0]!.headers.get('x-a')).toBe('1')
  } finally {
    resetRegistryForTests()
  }
})

test('without a registered Worker the server path keeps using the network', async () => {
  const urls: string[] = []
  const iso = createIsomorphicFetch({
    fetch: async (input) => {
      urls.push(String(input))
      return new Response('network')
    },
  })
  const previous = process.env.APP_URL
  process.env.APP_URL = 'https://app.example'
  try {
    expect(await (await iso('/api/x')).text()).toBe('network')
    expect(urls).toEqual(['https://app.example/api/x'])
  } finally {
    if (previous === undefined) delete process.env.APP_URL
    else process.env.APP_URL = previous
  }
})
```

Read the existing tests in this file first; keep them passing unchanged.

- [ ] **Step 5: Implement the in-isolate path**

In `src/start/isomorphic-fetch.ts`, before the existing server branch (after the `window` check):

```ts
    const worker = registeredWorker()
    if (worker && typeof input === 'string' && input.startsWith('/')) {
      const [env, incoming] = await Promise.all([
        isolate.env(),
        isolate.request(),
      ])
      const headers = new Headers(init?.headers)
      const cookie = incoming.headers.get('cookie')
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      const url = new URL(input, new URL(incoming.url).origin)
      return worker.fetch(new Request(url, { ...init, headers }), env, {
        waitUntil() {},
      })
    }
```

with, at the top of `createIsomorphicFetch`:

```ts
  const isolate = options.isolate ?? {
    env: async () =>
      (await import('cloudflare:workers')).env as WorkerEnv,
    request: async () =>
      (await import('@tanstack/react-start/server')).getRequest(),
  }
```

Import `registeredWorker` from `../workers/registry` and `type WorkerEnv` from `../workers/types`. Keep literal dynamic import specifiers (the file comment explains why).

`src/virtual.d.ts`:

```ts
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
}

declare module 'virtual:bunderstack/backend' {
  import type { BunderstackBackend } from './backend'
  export const backend: BunderstackBackend<any>
}
```

Make sure `tsconfig.build.json` includes it (it includes `src/**/*.ts`; a `.d.ts` in `src` is picked up — confirm with the typecheck in Step 9).

- [ ] **Step 6: `createStartWorker` and the package entries**

`src/start/create-start-worker.ts`:

```ts
// src/start/create-start-worker.ts — one Worker for a TanStack Start app:
// /api/* to bunderstack, every other path to Start SSR, cron to the Scheduler.
import type { BunderstackBackend } from '../backend'
import type { ExecutionContextLike, WorkerEnv } from '../workers/types'

import { createWorker } from '../workers/index'
import { registerWorker } from '../workers/registry'

type StartHandler = (request: Request) => Promise<Response>

export function createStartWorker(
  backend: BunderstackBackend<any>,
  startHandler?: StartHandler,
) {
  const worker = createWorker(backend)
  registerWorker(worker.handler)
  let start = startHandler
  const handler = {
    async fetch(
      request: Request,
      env: WorkerEnv,
      ctx: ExecutionContextLike,
    ): Promise<Response> {
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return worker.handler.fetch(request, env, ctx)
      }
      start ??= await defaultStartHandler()
      return start(request)
    },
    scheduled: worker.handler.scheduled,
  }
  return { handler, durableObjects: worker.durableObjects }
}

async function defaultStartHandler(): Promise<StartHandler> {
  const { createStartHandler, defaultStreamHandler } = await import(
    '@tanstack/react-start/server'
  )
  return createStartHandler(defaultStreamHandler) as StartHandler
}
```

`createWorker` already registers `worker.handler` (Step 3), so the `registerWorker` call here is redundant; keep only the one in `createWorker` and delete this line if the test in Step 7 passes without it.

`src/start/server-entry.ts`:

```ts
// bunderstack/start/server-entry — the Worker of a TanStack Start app with SSR.
// The app backend comes from the Vite virtual module that bunderstack() resolves.
import { backend } from 'virtual:bunderstack/backend'

import { createStartWorker } from './create-start-worker'

const worker = createStartWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

`src/workers/entry.ts`:

```ts
// bunderstack/workers/entry — the Worker of an SPA. The app backend comes from
// the Vite virtual module that bunderstack() resolves.
import { backend } from 'virtual:bunderstack/backend'

import { createWorker } from './index'

const worker = createWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

`src/start/index.ts`: `export { createStartWorker } from './create-start-worker'`.

`package.json` exports, next to `./start` and `./workers`:

```json
    "./start/server-entry": {
      "types": "./dist/start/server-entry.d.ts",
      "default": "./dist/start/server-entry.js"
    },
    "./workers/entry": {
      "types": "./dist/workers/entry.d.ts",
      "default": "./dist/workers/entry.js"
    },
```

- [ ] **Step 7: `createStartWorker` test**

`src/start/create-start-worker.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { bunderstack } from '../index'
import { registeredWorker, resetRegistryForTests } from '../workers/registry'
import { createStartWorker } from './create-start-worker'

test('routes /api to bunderstack, other paths to Start, and registers the Worker', async () => {
  resetRegistryForTests()
  const backend = bunderstack({
    schema: {},
    database: {
      adapter: {
        dialect: 'sqlite',
        driver: 'libsql',
        async connect() {
          throw new Error('not used')
        },
        async migrate() {},
      },
    } as never,
  })
  const started: string[] = []
  const worker = createStartWorker(backend, async (request) => {
    started.push(new URL(request.url).pathname)
    return new Response('ssr')
  })
  expect(registeredWorker()).toBeDefined()
  const page = await worker.handler.fetch(
    new Request('https://app.example/boards/1'),
    {},
    { waitUntil() {} },
  )
  expect(await page.text()).toBe('ssr')
  expect(started).toEqual(['/boards/1'])
  expect(Object.keys(worker.durableObjects).sort()).toEqual([
    'RateLimiter',
    'RealtimeHub',
    'Scheduler',
  ])
})
```

The `/api` branch needs a started app and a database; it is covered by the integration suite (Task 5), not here.

- [ ] **Step 8: Run tests**

```bash
cd packages/bunderstack && bun test src/workers src/start
```

Expected: PASS.

- [ ] **Step 9: Build, typecheck, boundaries**

```bash
cd packages/bunderstack && bunx tsc --noEmit -p tsconfig.json && bunx tsc --noEmit -p tsconfig.build.json && bun run build
ls dist/start/server-entry.js dist/workers/entry.js
cd ../.. && bun run test:boundaries && bun run test:bundles
```

Expected: both entry files exist; boundaries and bundles pass. If a boundary rule rejects `start/server-entry.ts` or `workers/entry.ts` for importing `virtual:bunderstack/backend` or `cloudflare:workers`, add those two specifiers to the rule's allow-list with the comment `// resolved by the app's Vite build`.

- [ ] **Step 10: Commit**

```bash
git add packages/bunderstack/src/workers/registry.ts packages/bunderstack/src/workers/registry.test.ts packages/bunderstack/src/workers/entry.ts packages/bunderstack/src/workers/index.ts packages/bunderstack/src/start packages/bunderstack/src/virtual.d.ts packages/bunderstack/package.json scripts/dependency-boundaries.test.ts
git commit -m "feat(start): package Worker entries and in-isolate fetch from Start server code"
```

---

### Task 3: The `bunderstack()` Vite plugin

**Files:**
- Modify: `packages/bunderstack/src/vite.ts`, `src/vite.test.ts`
- Modify: `packages/bunderstack/package.json` (optional peers `@cloudflare/vite-plugin` ^1.62.0 and `wrangler` ^4.143.0; devDependencies for tests if needed)

**Interfaces:**
- Consumes: the committed blueprint (`render`), `package.json#bunderstack.entry`.
- Produces:

```ts
export function bunderstack(options?: {
  /** Tests only: plugin factories instead of importing them from the app. */
  factories?: {
    cloudflare: (options: { viteEnvironment: { name: string } }) => unknown
    tanstackStart: (options: { srcDirectory: string }) => unknown
  }
  root?: string
}): Promise<unknown[]>
```

Behavior:
1. Read `bunderstack.blueprint.yaml` from `root` (default `process.cwd()`) with `parseWorkerBlueprintYaml`; throw `[bunderstack] run \`bunderstack dev\` or \`bunderstack blueprint\` first` when it is missing.
2. Resolve the backend entry: `package.json#bunderstack.entry` or `src/bunderstack.ts`, absolute.
3. Return, in this order:
   - a plugin named `bunderstack:backend` with `resolveId(id) { if (id === 'virtual:bunderstack/backend') return backendEntry }` and `config()` returning `{ build: { outDir: 'dist/client' }, environments: { ssr: { build: { outDir: 'dist/server' } } } }`;
   - `cloudflare({ viteEnvironment: { name: 'ssr' } })`;
   - for `render: ssr` only: `tanstackStart({ srcDirectory: 'src' })`.
4. `cloudflare` and `tanstackStart` are imported with `await import(...)` resolved from the app (`Bun.resolveSync` is not available in Vite's Node runtime; use `createRequire(join(root, 'package.json')).resolve(...)` and `import(pathToFileURL(...).href)`), so the bunderstack package does not depend on them.
5. The `/api` proxy and `BUNDERSTACK_DEV_API_URL` are removed.

- [ ] **Step 1: Rewrite `vite.test.ts`**

```ts
import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blueprintFromManifest, serializeBlueprint } from './blueprint'
import { bunderstack } from './vite'

async function app(render: 'ssr' | 'spa') {
  const root = await mkdtemp(join(tmpdir(), 'bunderstack-vite-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
  const blueprint = blueprintFromManifest({
    manifest: {
      version: 4,
      database: { dialect: 'sqlite', migrationsDirectory: './migrations', tables: [] },
      storage: { defaultBucket: 'media', buckets: [{ name: 'media', visibility: 'private' }] },
      realtime: { required: false },
      messaging: { channels: [] },
      environment: [],
      api: { operations: [] },
      background: { jobs: [], cron: [], maintenance: [] },
    },
    generatorVersion: '1.0.0-beta.4',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    worker: {
      render,
      main: render === 'ssr' ? 'bunderstack/start/server-entry' : 'bunderstack/workers/entry',
      compatibilityDate: '2026-09-28',
      assets: 'dist/client',
    },
  })
  await writeFile(join(root, 'bunderstack.blueprint.yaml'), serializeBlueprint(blueprint))
  return root
}

const factories = {
  cloudflare: (options: unknown) => ({ name: 'cloudflare', options }),
  tanstackStart: (options: unknown) => ({ name: 'tanstack-start', options }),
}

test('ssr: backend resolver, Cloudflare on the ssr environment, then Start', async () => {
  const root = await app('ssr')
  try {
    const plugins = (await bunderstack({ root, factories })) as { name: string; options?: unknown; resolveId?: (id: string) => unknown }[]
    expect(plugins.map((p) => p.name)).toEqual(['bunderstack:backend', 'cloudflare', 'tanstack-start'])
    expect(plugins[1]!.options).toEqual({ viteEnvironment: { name: 'ssr' } })
    expect(plugins[0]!.resolveId!('virtual:bunderstack/backend')).toBe(join(root, 'src/bunderstack.ts'))
    expect(plugins[0]!.resolveId!('other')).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('spa: no Start plugin; outDirs match the artifact', async () => {
  const root = await app('spa')
  try {
    const plugins = (await bunderstack({ root, factories })) as { name: string; config?: () => unknown }[]
    expect(plugins.map((p) => p.name)).toEqual(['bunderstack:backend', 'cloudflare'])
    expect(plugins[0]!.config!()).toEqual({
      build: { outDir: 'dist/client' },
      environments: { ssr: { build: { outDir: 'dist/server' } } },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing blueprint asks to generate it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunderstack-vite-'))
  try {
    await writeFile(join(root, 'package.json'), '{}')
    await expect(bunderstack({ root, factories })).rejects.toThrow(/bunderstack blueprint/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run** — `bun test src/vite.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/vite.ts`**

```ts
// src/vite.ts — `bunderstack()` for vite.config.ts. It runs the app as a
// Worker through the Cloudflare Vite plugin (with TanStack Start for SSR) and
// points the package Worker entries at the app's backend. No import of `vite`
// or of the plugins at module load: they are resolved from the app.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseWorkerBlueprintYaml } from './blueprint'

type Factories = {
  cloudflare: (options: { viteEnvironment: { name: string } }) => unknown
  tanstackStart: (options: { srcDirectory: string }) => unknown
}

async function appFactories(root: string, ssr: boolean): Promise<Factories> {
  const require = createRequire(join(root, 'package.json'))
  const load = async (specifier: string) =>
    import(pathToFileURL(require.resolve(specifier)).href)
  const { cloudflare } = await load('@cloudflare/vite-plugin')
  const tanstackStart = ssr
    ? (await load('@tanstack/react-start/plugin/vite')).tanstackStart
    : () => {
        throw new Error('[bunderstack] TanStack Start is only used for render: ssr')
      }
  return { cloudflare, tanstackStart }
}

export async function bunderstack(
  options: { root?: string; factories?: Factories } = {},
): Promise<unknown[]> {
  const root = resolve(options.root ?? process.cwd())
  let source: string
  try {
    source = await readFile(join(root, 'bunderstack.blueprint.yaml'), 'utf8')
  } catch {
    throw new Error(
      '[bunderstack] bunderstack.blueprint.yaml is missing; run `bunderstack dev` or `bunderstack blueprint` first',
    )
  }
  const blueprint = parseWorkerBlueprintYaml(source)
  const ssr = blueprint.application.worker.render === 'ssr'
  const pkg = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { bunderstack?: { entry?: string } }
  const backendEntry = join(root, pkg.bunderstack?.entry ?? 'src/bunderstack.ts')
  const { cloudflare, tanstackStart } =
    options.factories ?? (await appFactories(root, ssr))
  return [
    {
      name: 'bunderstack:backend',
      resolveId(id: string) {
        if (id === 'virtual:bunderstack/backend') return backendEntry
        return undefined
      },
      config() {
        return {
          build: { outDir: 'dist/client' },
          environments: { ssr: { build: { outDir: 'dist/server' } } },
        }
      },
    },
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    ...(ssr ? [tanstackStart({ srcDirectory: 'src' })] : []),
  ]
}
```

- [ ] **Step 4: Run tests** — `bun test src/vite.test.ts` → PASS. Typecheck both configs.

- [ ] **Step 5: package.json peers**

Add to `peerDependencies`: `"@cloudflare/vite-plugin": "^1.62.0"`, `"wrangler": "^4.143.0"`; mark both optional in `peerDependenciesMeta` (an app that never runs `bunderstack dev` or `build` does not need them).

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/vite.ts packages/bunderstack/src/vite.test.ts packages/bunderstack/package.json
git commit -m "feat(vite)!: bunderstack() runs the app as a Worker through the Cloudflare plugin"
```

---

### Task 4: `bunderstack dev` on Vite, `bunderstack build` artifact checks

**Files:**
- Modify: `packages/bunderstack/src/dev/index.ts` (`planDev`, `runDev`, `runBuild`)
- Modify: `packages/bunderstack/src/dev/index.test.ts`
- Modify: `packages/bunderstack/src/cli.ts` (help text for `dev` and `build`)

**Interfaces:**
- Produces:

```ts
export type DevPlan = {
  appUrl: string // http://localhost:<port>
  databaseUrl: string
  sqld?: ProcessSpec
  vite: ProcessSpec
}
export function planDev(input: {
  directory: string
  stateDir: string
  userEnv: Record<string, string>
  ports: { app: number; db: number }
  binaries: { sqld: string }
}): DevPlan
export async function cleanArtifact(directory: string): Promise<string[]> // removed paths
```

- [ ] **Step 1: Rewrite the plan tests**

In `src/dev/index.test.ts`, replace the two `planDev` tests (`'with Vite: sqld, celld, and Vite with the API proxy'` and `'without Vite: celld serves…'`) and the `celldLine` test with:

```ts
const base = {
  directory: '/app',
  stateDir: '/app/.bunderstack/dev',
  ports: { app: 5173, db: 9002 },
  binaries: { sqld: '/bin/sqld' },
}

test('dev runs sqld and Vite; no celld', () => {
  const plan = planDev({ ...base, userEnv: {} })
  expect(plan.appUrl).toBe('http://localhost:5173')
  expect(plan.databaseUrl).toBe('http://127.0.0.1:9002')
  expect(plan.sqld?.cmd[0]).toBe('/bin/sqld')
  expect(plan.vite.cmd).toContain('--strictPort')
  expect(plan.vite.cmd).toContain('5173')
  expect('worker' in plan).toBe(false)
})
```

Keep the existing `'a database URL from .env replaces sqld'` test, adjusted to the new `base` (no `hasVite`, no `api` port, no celld binary). Delete `celldLine` and its test (no celld in dev).

Add:

```ts
test('cleanArtifact removes .assetsignore and every .dev.vars under dist', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'bunderstack-art-'))
  try {
    await mkdir(join(directory, 'dist/client'), { recursive: true })
    await mkdir(join(directory, 'dist/server/assets'), { recursive: true })
    await writeFile(join(directory, 'dist/client/.assetsignore'), 'wrangler.json\n')
    await writeFile(join(directory, 'dist/server/.dev.vars'), 'AUTH_SECRET=x\n')
    await writeFile(join(directory, 'dist/server/assets/.dev.vars'), 'X=1\n')
    await writeFile(join(directory, 'dist/server/index.js'), 'export default {}\n')
    const removed = await cleanArtifact(directory)
    expect(removed.sort()).toEqual([
      'dist/client/.assetsignore',
      'dist/server/.dev.vars',
      'dist/server/assets/.dev.vars',
    ])
    expect(await Bun.file(join(directory, 'dist/server/index.js')).exists()).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

Update the `runBuild` test: the fixture app gets a `vite.config.ts` only if the test can run Vite; keep the fixture without a Vite config and assert that `runBuild` returns 1 with a message containing `vite.config` (a Worker app always builds through Vite now), then that `wrangler.json` was still written before that failure is not required — assert only the exit code and message. The blueprint checks stay as they are.

- [ ] **Step 2: Run** — `bun test src/dev/index.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`planDev`: drop `apiUrl`, `worker`, `hasVite`, and the `api` port; `vite` is always present:

```ts
    vite: {
      name: 'vite',
      cmd: [process.execPath, 'x', '--bun', 'vite', '--port', String(ports.app), '--strictPort'],
      cwd: directory,
    },
```

`runDev`:
- resolve only the sqld binary (`resolveBinary('sqld', …)` unless the database is external);
- throw `[bunderstack] vite.config.ts is missing; add bunderstack() to it` when `hasViteConfig` is false;
- `devVars({ userEnv, databaseUrl, appUrl: plan.appUrl, authSecret })` — `appUrl` is `http://localhost:<port>`;
- after the first push, `group.start(plan.vite)`, then wait for `${plan.appUrl}/api/health` (60 s) and print `App: ${plan.appUrl}`;
- delete `esbuildBinary()` and the celld start.

`cleanArtifact(directory)`: walk `dist/` with `readdir(..., { recursive: true, withFileTypes: true })`, remove `dist/client/.assetsignore` and every file named `.dev.vars`, return the removed paths relative to `directory` with `/` separators.

`runBuild`:

```ts
export async function runBuild(options: { directory: string }): Promise<number> {
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
  if (!(await hasViteConfig(directory))) {
    console.error('[bunderstack] vite.config.ts is missing; add bunderstack() to it')
    return 1
  }
  const vite = Bun.spawn([process.execPath, 'x', '--bun', 'vite', 'build'], {
    cwd: directory,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await vite.exited) !== 0) return 1
  for (const path of await cleanArtifact(directory)) console.log(`removed ${path}`)
  if (!(await Bun.file(join(directory, 'dist/server/index.js')).exists())) {
    console.error('[bunderstack] the build did not produce dist/server/index.js')
    return 1
  }
  return 0
}
```

`src/cli.ts` help: `dev` — "Start the app locally: sqld and Vite, with the Worker (SSR, /api, Durable Objects) in workerd. Regenerates bunderstack.blueprint.yaml and wrangler.json and pushes the schema on each change under src/. Ctrl+C stops everything." `build` — "Check that bunderstack.blueprint.yaml is current, write wrangler.json from it, build the Worker and client with Vite into dist/server and dist/client, and remove files hosts must not deploy."

Also remove `celld` from `src/dev/binaries.ts` callers only; keep the pinned download code (used by `scripts/workers-integration.ts` through `CELLD_BIN`). If nothing imports the celld pin any more, leave `binaries.ts` unchanged; do not delete code that tests still cover.

- [ ] **Step 4: Run tests and typecheck**

```bash
cd packages/bunderstack && bun test src/dev src/cli.test.ts && bunx tsc --noEmit -p tsconfig.json && bunx tsc --noEmit -p tsconfig.build.json
```

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/dev packages/bunderstack/src/cli.ts
git commit -m "feat(dev)!: dev runs Vite with the Worker in workerd; build cleans the artifact"
```

---

### Task 5: Examples on the package entries, `ssr-probe`, and `test:workers` on the artifact

**Files:**
- Delete: `examples/todo-solid-native/src/worker.ts`, `examples/agent-chat/src/worker.ts`, `examples/workers-probe/src/worker.ts`
- Modify: `examples/todo-solid-native/vite.config.ts`, `examples/agent-chat/vite.config.ts`
- Create: `examples/workers-probe/vite.config.ts`, move `examples/workers-probe/public/index.html` to `examples/workers-probe/index.html` (Vite builds the SPA from the root `index.html`)
- Modify: each example's `package.json` (devDependencies `@cloudflare/vite-plugin` ^1.62.0, `wrangler` ^4.143.0; `workers-probe` also `vite` ^8.0.0) and regenerate its blueprint
- Create: `examples/ssr-probe/` (from the spike, see Step 3)
- Modify: `scripts/workers-integration.ts` (build each app, run celld/wrangler on the artifact config, SSR scenarios)
- Modify: root `package.json` `typecheck:examples` (add `ssr-probe`)

- [ ] **Step 1: SPA examples**

`examples/todo-solid-native/vite.config.ts`:

```ts
import solid from '@solidjs/vite-plugin'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // The app runs as a Worker in dev and in the build; see bunderstack().
  plugins: [bunderstack(), solid()],
})
```

`examples/agent-chat/vite.config.ts`: same pattern — `plugins: [bunderstack(), tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()]`, keep `resolve` and `envPrefix`.

`examples/workers-probe/vite.config.ts`:

```ts
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [bunderstack()] })
```

Then:

```bash
git rm -q examples/todo-solid-native/src/worker.ts examples/agent-chat/src/worker.ts examples/workers-probe/src/worker.ts
git mv examples/workers-probe/public/index.html examples/workers-probe/index.html
```

Add the devDependencies, then `bun install` at the root. Regenerate each blueprint after deleting `main` and `render` from its `application.worker` (so the new defaults apply): edit the YAML to remove the `main:` line, then run `bun ../../packages/bunderstack/src/cli.ts blueprint .` in each example. Expected: `render: spa`, `main: bunderstack/workers/entry`; `workers-probe` keeps `assets: public` — change it to `dist/client` (the probe now builds through Vite).

Verify each builds: `bun ../../packages/bunderstack/src/cli.ts build .` → `dist/server/index.js` and `dist/client/index.html` exist; no `.dev.vars` or `.assetsignore` under `dist/`.

- [ ] **Step 2: `ssr-probe` example**

Copy the spike app from the scratchpad (`/private/tmp/claude-501/-Users-kirill-Projects-bunderstack-project-bunderhost/dea11d87-9924-421a-9fc6-a367c35cfd5e/scratchpad/ssr-probe`) as a starting point, then make it a proper example:

- `package.json`: name `bunderstack-example-ssr-probe`, scripts `{ "dev": "bunderstack dev", "build": "bunderstack build" }`, dependencies as in the spike plus `@tanstack/react-query`, devDependencies `@cloudflare/vite-plugin`, `wrangler`, `@vitejs/plugin-react`, `vite`, `@types/react`, `@types/react-dom`.
- Delete `setup-probe.ts`, `node_modules/bs-entry`, `src/backend-call.ts`, `wrangler.json`, `.dev.vars`.
- `vite.config.ts`: `plugins: [bunderstack(), viteReact()]`.
- `src/bunderstack.ts`: the `workers-probe` backend (copy it), with `export type App = …` as the other examples declare it.
- `src/api.ts`:

```ts
import type { App } from './bunderstack'

import { bunderstackStart } from 'bunderstack/start'

export const { createQueryClient, createApi } = bunderstackStart<App>()
export const queryClient = createQueryClient()
export const api = createApi(queryClient)
```

- Routes: `__root.tsx` loads the session through `api` in `beforeLoad` (read how the existing query client exposes auth — `api.auth` or a `getSession` procedure — in `packages/bunderstack/src/query/client.ts`; if neither exists, `fetch` through `createIsomorphicFetch()` from `bunderstack/start` to `/api/auth/get-session`); `index.tsx` loader lists `events` through `api`, the component shows `id="ssr"`, `id="user"`, `id="events"`, a hydration button `id="hydrated"`, a link to `/second`, and a live list from `/api/live/notes`; `second.tsx` loads a note count through a `createServerFn` that calls `api`.
- `.gitignore`: `.bunderstack/`, `.wrangler/`, `.dev.vars`, `wrangler.json`, `dist/`.
- Generate the blueprint: `bun ../../packages/bunderstack/src/cli.ts blueprint .` → `render: ssr`, `main: bunderstack/start/server-entry`.
- Build: `bun ../../packages/bunderstack/src/cli.ts build .`.

- [ ] **Step 3: Integration script on the artifact**

In `scripts/workers-integration.ts`:
- replace the single `probe` directory with `apps = [{ dir: 'examples/workers-probe', scenarios: existing }, { dir: 'examples/ssr-probe', scenarios: ssrScenarios }]` and run setup + scenarios for each;
- setup per app: `runBuild({ directory })` from `packages/bunderstack/src/dev/index`, assert 0; then write `wrangler.artifact.json` with `toWranglerConfig(workerPlanFromBlueprint(parseWorkerBlueprintYaml(blueprint)), { name, bucketName: (b) => \`${name}-${b}\` }, { artifact: true })`; celld runs `celld dev wrangler.artifact.json …`, wrangler runs `wrangler dev --config wrangler.artifact.json …`; delete the file in the cleanup list;
- `ssrScenarios`:

```ts
const ssrScenarios: Scenario[] = [
  ['ssr page with the signed-in user', async (ctx) => {
    const html = await (await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } })).text()
    if (!html.includes('id="ssr"')) throw new Error('no SSR markup')
    if (!html.includes(ctx.email)) throw new Error('SSR does not show the user')
  }],
  ['loader reads through api in the isolate', async (ctx) => {
    const html = await (await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } })).text()
    if (!/events status (<!-- -->)?200/.test(html)) throw new Error('loader did not reach the backend')
  }],
  ['server function page renders data', async (ctx) => {
    const html = await (await fetch(`${ctx.base}/second`, { headers: { cookie: ctx.cookie } })).text()
    if (!/status (<!-- -->)?200/.test(html)) throw new Error('server function did not reach the backend')
  }],
]
```

`ctx.email` is the address the existing auth scenario signs up; add it to the context if the script does not keep it. Client-side hydration and realtime are covered by the dev smoke in Step 5, not here (no browser in CI).

- [ ] **Step 4: Run the suite**

```bash
CELLD_BIN=~/.cache/bunderstack/celld-v0.6.0-aarch64-apple-darwin/celld SQLD_BIN=$(ls -d ~/.cache/bunderstack/sqld-v0.24.32-aarch64-apple-darwin/*/sqld) bun run test:workers
SQLD_BIN=$(ls -d ~/.cache/bunderstack/sqld-v0.24.32-aarch64-apple-darwin/*/sqld) bun run test:workers -- --runtime workerd
bun run typecheck:examples
```

Expected: all scenarios pass for both apps on both runtimes; examples typecheck.

- [ ] **Step 5: Dev smoke (manual, record the output)**

```bash
cd examples/ssr-probe && bun ../../packages/bunderstack/src/cli.ts dev
```

In the browser pane at the printed `http://localhost:<port>`: sign up through `/api/auth/sign-up/email` with a test account, reload, confirm the SSR page shows the user, click `#hydrated` (counter increases), create a note with `POST /api/notes` and see it appear in the live list, follow the `/second` link (client-side server function). Add a column to a table in `src/schema.ts` and confirm the dev log prints `schema is current` after the push. Revert the schema edit. Record what you saw in the commit message.

- [ ] **Step 6: Commit**

```bash
git add examples/todo-solid-native examples/agent-chat examples/workers-probe examples/ssr-probe scripts/workers-integration.ts package.json bun.lock
git commit -m "feat(examples): package Worker entries, ssr-probe, and test:workers on the build artifact"
```

---

### Task 6: Documentation and the skill

**Files:**
- Modify: `.agents/skills/creating-bunderstack-apps/SKILL.md` and `references/runtime-integrations.md`
- Modify: `website/content/docs/` pages that describe `src/worker.ts`, `/api/$`, or `createApiHandlers` for 1.0 (find them with `git grep -n "src/worker.ts\|createWorker\|api/\\$" -- website/content .agents`)
- Regenerate: `packages/bunderstack/llms-full.txt` (`bun run docs:llms`)

- [ ] **Step 1: Write the developer surface**

In the skill's `runtime-integrations.md`, replace the Worker section with the app layout from the spec ("Developer surface"): the four files, `bunderstack()` in `vite.config.ts`, `bunderstackStart<App>()` in `src/api.ts`, the `render` modes, the optional `src/server.ts` with `createStartWorker`, and the runtime constraints list (Web APIs plus `nodejs_compat`; no `Bun.*`, local disk, or raw TCP; long work in jobs; files in a bucket). Keep the 0.x content only where it is labeled 0.x.

In `SKILL.md`, step 3 says: "For a new app, use TanStack Start with `render: ssr` (the default); an SPA sets `render: spa` in the blueprint."

- [ ] **Step 2: Regenerate and check**

```bash
bun run docs:llms
bun test scripts/
```

Expected: PASS (skills and llms contract tests).

- [ ] **Step 3: Commit**

```bash
git add .agents website/content packages/bunderstack/llms-full.txt
git commit -m "docs: SSR by default and the Worker-free app layout"
```

---

### Task 7: Release beta.4

**Files:** `CHANGELOG.md`, `packages/bunderstack/CHANGELOG.md`, `packages/bunderstack/package.json`, example blueprints (generator version)

- [ ] **Step 1: Changelog** — add above `## [1.0.0-beta.3]` in both files:

```markdown
## [1.0.0-beta.4] — 2026-09-29

### Added

- SSR by default for TanStack Start apps: `render: ssr` in
  `application.worker`. The page, loaders, and server functions run in the same
  Worker as the API; `bunderstackStart<App>()`'s client calls the backend in
  the isolate on the server and forwards the request cookie.
- Package Worker entries `bunderstack/start/server-entry` and
  `bunderstack/workers/entry`. Apps no longer write `src/worker.ts`; a custom
  `src/server.ts` with `createStartWorker(backend)` stays possible.
- `WorkerPlan.render`, `assets.notFoundHandling`, and `artifact`
  (`dist/server/index.js` and `dist/client`).

### Changed

- `bunderstack()` in `vite.config.ts` runs the app through
  `@cloudflare/vite-plugin` (and TanStack Start for SSR). Add
  `@cloudflare/vite-plugin` and `wrangler` as dev dependencies.
- `bunderstack dev` runs sqld and Vite; the Worker runs in workerd with HMR.
  celld no longer runs in dev. `APP_URL` in `.dev.vars` uses `localhost`.
- `bunderstack build` builds `dist/server` and `dist/client` with Vite and
  removes `dist/client/.assetsignore` and every `.dev.vars` under `dist/`.
- `application.worker.render` is required; regenerate beta.3 blueprints.

### Removed

- The `/api` dev proxy in `bunderstack/vite` and `BUNDERSTACK_DEV_API_URL`.
```

- [ ] **Step 2: Version and regenerate** — set `"version": "1.0.0-beta.4"`, then regenerate the blueprints of `todo-solid-native`, `agent-chat`, `workers-probe`, `ssr-probe`.

- [ ] **Step 3: Full verification** — `bun run test`, package `bun test`, `bun run typecheck:all`, `test:boundaries`, `test:bundles`, `test:workers` on celld and workerd. No new failures against the baseline.

- [ ] **Step 4: Commit** — `git commit -m "release: bunderstack 1.0.0-beta.4"` with the counts in the body.

- [ ] **Step 5: Publish (ask the user first)** — `git push origin next`; confirm the publish run and `npm view bunderstack dist-tags` shows `beta: 1.0.0-beta.4`.
