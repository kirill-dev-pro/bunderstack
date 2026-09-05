# Env-first Declarations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the object form with `bunderstack({ schema, env }, env => config)`, adding per-start resolution, explicit inspection, and blueprint shape probes.

**Outcome (2026-09-05):** Implemented. The declaration's static half moved into
the first argument after the two-argument form was found to break inference for
every inline `jobs`, `api`, and `auth` builder; see the design's decision 1.

**Architecture:** Store either a static config or an env schema plus pure config factory in backend internals. Route `start()`, `test()`, and `inspect()` through one materializer that validates env before resolving the factory. Build manifests from resolved configuration without starting runtime resources.

**Tech Stack:** Bun, TypeScript, Valibot/Standard Schema, Drizzle metadata, oRPC metadata.

**Spec:** `docs/superpowers/specs/2026-09-04-env-first-declarations-design.md`

## Global Constraints

- The single-argument `bunderstack(config)` form and the eager `backend.manifest` property are removed.
- Env-first factories are resolved independently for every inspection, start, and test fixture.
- Inspection performs no database, storage, network, provider, or worker I/O.
- Manifest errors and diffs never contain environment values.
- Use Bun for tests and scripts.

---

### Task 1: Model static and env-first backend declarations

**Files:**

- Modify: `packages/bunderstack/src/backend-internals.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Test: `packages/bunderstack/src/backend.test.ts`
- Test: `packages/bunderstack/src/config-env-inference.test.ts`

**Interfaces:**

- Consumes: `EnvConfigInput`, `ValidatedEnv<TEnv>`, and `BunderstackDefinitionConfig`.
- Produces: `EnvFirstBunderstackBackend<TApp>`, `StaticBunderstackBackend<TApp>`, and overloads for `bunderstack(config)` and `bunderstack(envSchema, factory)`.

- [x] **Step 1: Write compile-time and runtime failing tests**

Add an inference fixture equivalent to:

```ts
const envSchema = { server: { TENANT: v.string() } }
const backend = bunderstack(envSchema, (env) => {
  expectTypeOf(env.TENANT).toEqualTypeOf<string>()
  return {
    schema,
    database: { adapter: libsql(), url: `file:${env.TENANT}.db` },
  }
})
expectTypeOf(backend.inspect).toBeFunction()
```

Add a runtime test asserting the factory is not called by module construction,
is called once per `inspect()` invocation, and receives each invocation's
validated value.

- [x] **Step 2: Run the focused tests and verify failure**

Run:

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/config-env-inference.test.ts
```

Expected: TypeScript/runtime failure because the two-argument overload and
`inspect` do not exist.

- [x] **Step 3: Add declaration unions and overloads**

Represent internals explicitly:

```ts
export type StaticBackendDeclaration = {
  kind: 'static'
  config: BunderstackDefinitionConfig<any, any, any, any, any, any, any>
}

export type EnvFirstBackendDeclaration = {
  kind: 'env-first'
  envSchema: EnvConfigInput
  factory: (
    env: BaseEnv,
  ) => BunderstackDefinitionConfig<any, any, any, any, any, any, any>
}
```

Add the new overload before the implementation signature so contextual typing
flows from `envSchema` into the callback. Keep the existing overload's return
type exposing `readonly manifest`.

- [x] **Step 4: Run typecheck and focused tests**

Run:

```bash
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/config-env-inference.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/bunderstack/src/backend.ts packages/bunderstack/src/backend-internals.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/config-env-inference.test.ts
git commit -m "feat: declare env-first backends"
```

---

### Task 2: Extract pure configuration inspection

**Files:**

- Create: `packages/bunderstack/src/inspect.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Test: `packages/bunderstack/src/backend.test.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`

**Interfaces:**

- Consumes: either backend declaration and a raw env source.
- Produces: `inspectDeclaration(declaration, source): ResolvedDefinition` where `ResolvedDefinition` contains `config`, `jobsDefs`, `customApiRouter`, and `manifest`.

- [x] **Step 1: Write failing inspection isolation tests**

Assert that two calls with `{ TENANT: 'a' }` and `{ TENANT: 'b' }` produce the
corresponding migration directories while retaining separate config objects.
Use adapters with no connection side effects and assert their `connect` methods
were never called.

- [x] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/app-env.test.ts
```

Expected: FAIL because inspection is still coupled to eager backend creation.

- [x] **Step 3: Implement the pure resolver**

Move these declaration-time operations from `backend.ts` into `inspect.ts`:

```ts
export function inspectDeclaration(
  declaration: BackendDeclaration,
  source: Record<string, string | undefined>,
): ResolvedDefinition
```

Its order must be:

```ts
const env = validateEnv(envSchema, { source })
const config = factory ? factory(env) : staticConfig
const jobsDefs = resolveJobs(config.jobs)
const customApiRouter = resolveApi(config.api)
const manifest = buildManifestFromDefinition(config, jobsDefs, customApiRouter)
return { config, jobsDefs, customApiRouter, manifest }
```

Move provider-specific required-env checks out of the initial parse and perform
them after config resolution without reparsing or changing values.

- [x] **Step 4: Make both backend forms use inspection**

The static form inspects once and caches its immutable result. The env-first
form calls `inspectDeclaration` for every `inspect()` and passes the returned
resolved definition to `start()` without invoking the factory a second time in
that operation.

- [x] **Step 5: Verify focused tests**

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/config.test.ts
```

Expected: PASS and zero adapter connections during `inspect()`.

- [x] **Step 6: Commit**

```bash
git add packages/bunderstack/src/inspect.ts packages/bunderstack/src/backend.ts packages/bunderstack/src/config.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/app-env.test.ts
git commit -m "feat: inspect resolved backend declarations"
```

---

### Task 3: Materialize the exact inspected definition

**Files:**

- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Test: `packages/bunderstack/src/backend.test.ts`
- Test: `packages/bunderstack/src/testing/fixture.test.ts`

**Interfaces:**

- Consumes: `ResolvedDefinition` from Task 2.
- Produces: `materializeBunderstack(resolved, source, overrides)` without resolving jobs/API/config again.

- [x] **Step 1: Write failing multi-start and multi-fixture tests**

Create one env-first backend and start two isolated test fixtures:

```ts
const first = await backend.test({ env: { TENANT: 'first' } })
const second = await backend.test({ env: { TENANT: 'second' } })
expect(first.app.env.TENANT).toBe('first')
expect(second.app.env.TENANT).toBe('second')
```

Add a counter proving one operation invokes the declaration factory exactly
once and no configuration leaks between fixtures.

- [x] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/testing/fixture.test.ts
```

Expected: FAIL until runtime consumes `ResolvedDefinition`.

- [x] **Step 3: Change the materialization boundary**

Pass the already resolved config, jobs, API router, env, and manifest into
runtime construction. Delete duplicate calls to `validateEnv`, jobs builders,
and API builders along that path. Retain runtime-only database/storage/provider
creation in `runtime.ts`.

- [x] **Step 4: Verify lifecycle tests**

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/jobs/runtime.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/bunderstack/src/backend.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/testing/fixture.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/testing/fixture.test.ts
git commit -m "refactor: materialize inspected declarations"
```

---

### Task 4: Add blueprint purity probes and structural diffs

**Files:**

- Create: `packages/bunderstack/src/manifest-diff.ts`
- Create: `packages/bunderstack/src/env-probe.ts`
- Modify: `packages/bunderstack/src/blueprint-generator.ts`
- Test: `packages/bunderstack/src/blueprint-generator.test.ts`
- Test: `packages/bunderstack/src/manifest.test.ts`

**Interfaces:**

- Consumes: `backend.inspect({ env })` and normalized manifests.
- Produces: `diffManifests(expected, actual): ManifestDifference[]` and generated probe sources that contain key names but no user values.

- [x] **Step 1: Write failing probe tests**

Cover a stable value-only factory and an unstable factory:

```ts
;(env) => ({
  schema,
  database,
  realtime: env.FEATURE_FLAG === 'enabled',
})
```

Assert the unstable case fails with paths such as `realtime.required`, while
the error contains neither probe values nor serialized configs.

- [x] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/manifest.test.ts
```

Expected: FAIL because env-first backends cannot yet generate blueprints.

- [x] **Step 3: Implement deterministic probes**

Build two raw sources from declared key names. Include valid base values in both:

```ts
{
  NODE_ENV: 'production',
  AUTH_SECRET: 'bunderstack-blueprint-probe-secret',
  DATABASE_URL: 'file:./bunderstack-blueprint-probe.db',
  BUNDERSTACK_ROLE: 'all',
}
```

For application keys, try a bounded candidate corpus through each Standard
Schema and retain two distinct accepted raw sources when possible. Use, in
order, the currently configured raw value when present, `undefined`, `''`,
`'probe'`, `'true'`, `'false'`, `'0'`, `'1'`,
`'https://example.invalid'`, `'file:./bunderstack-probe.db'`,
`'probe@example.invalid'`, and `'00000000-0000-4000-8000-000000000000'`.
When only one valid value can be produced, use it in both probes. When none
validates, throw `BlueprintProbeError` naming only the env key and instructing
the developer to provide a valid value while generating the blueprint. Never
print candidates or the configured value.

- [x] **Step 4: Compare normalized manifests before writing**

Use the first manifest as the blueprint input only after every probe manifest
matches. Render differences as sorted `added`, `removed`, and `changed` paths.
Keep the generator's existing atomic file replacement behavior.

- [x] **Step 5: Verify blueprint tests**

```bash
bun test packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/manifest.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/bunderstack/src/env-probe.ts packages/bunderstack/src/manifest-diff.ts packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/manifest.test.ts
git commit -m "feat: detect environment-dependent blueprint shape"
```

---

### Task 5: Add hosted contract checking

**Files:**

- Modify: `packages/bunderstack/src/cli.ts`
- Modify: `packages/bunderstack/src/blueprint-generator.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Modify: `packages/bunderstack/src/env.ts`
- Test: `packages/bunderstack/src/cli.test.ts`
- Test: `packages/bunderstack/src/backend.test.ts`

**Interfaces:**

- Consumes: an existing blueprint plus an inspected manifest.
- Produces: `bunderstack blueprint --hosted-check` and automatic
  `BUNDERSTACK_BLUEPRINT_PATH` checking before runtime materialization.

- [x] **Step 1: Write failing hosted-check tests**

Add CLI tests for a matching contract, a mismatch with sorted structural paths,
a missing blueprint, and an error that never contains supplied secret values.
Add a backend test proving a final mismatch occurs before the database adapter's
`connect()` method.

- [x] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/cli.test.ts packages/bunderstack/src/backend.test.ts
```

Expected: FAIL because hosted checking does not exist.

- [x] **Step 3: Implement explicit hosted CLI checking**

Add `--hosted-check` as a mode mutually exclusive with `--check`. Import the
backend, call `backend.inspect({ env: process.env })`, convert its manifest with
the existing blueprint conversion, normalize generator-only and migration-mode
fields from the committed blueprint, and call `diffManifests`. Exit non-zero
with added, removed, and changed paths on mismatch.

- [x] **Step 4: Enforce the embedded blueprint during start**

When the start source contains `BUNDERSTACK_BLUEPRINT_PATH`, read and parse that
file, compare it with the already inspected definition, and only then call
`materializeBunderstack`. Keep this reserved key out of user-declared env
metadata. A mismatch must happen before database, storage, auth, messaging,
realtime, or worker construction.

- [x] **Step 5: Run hosted-check tests**

```bash
bun test packages/bunderstack/src/cli.test.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/blueprint-generator.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/bunderstack/src/cli.ts packages/bunderstack/src/cli.test.ts packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/backend.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/env.ts
git commit -m "feat: verify hosted blueprint contracts"
```

---

### Task 6: Document, build, and verify the public API

**Files:**

- Modify: `website/content/docs/getting-started.mdx`
- Modify: `website/content/docs/env.mdx`
- Modify: `website/content/docs/api-reference.mdx`
- Create: `docs/MIGRATION-0.24.md`
- Modify: `website/scripts/gen-code-snippets.ts`

**Interfaces:**

- Consumes: completed env-first API.
- Produces: published declarations and migration guidance.

- [x] **Step 1: Update documentation examples**

Show both overloads, explain that the callback may run repeatedly, distinguish
best-effort local probes from Bunderhost's deployment contract, and state that
`inspect()` performs no I/O.

- [x] **Step 2: Regenerate generated documentation artifacts**

```bash
bun run website/scripts/gen-code-snippets.ts
```

Expected: generated snippets use the env-first form where runtime values are
needed.

- [x] **Step 3: Run package verification**

```bash
bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/testing/fixture.test.ts
bun run build
bun run verify:consumer
bun run typecheck:all
```

Expected: all commands PASS and packed declarations retain the callback's exact
env type.

- [x] **Step 4: Commit**

```bash
git add website/content/docs/getting-started.mdx website/content/docs/env.mdx website/content/docs/api-reference.mdx website/scripts/gen-code-snippets.ts website/src/lib/code-snippets.gen.json docs/MIGRATION-0.24.md
git commit -m "docs: explain env-first backend declarations"
```
