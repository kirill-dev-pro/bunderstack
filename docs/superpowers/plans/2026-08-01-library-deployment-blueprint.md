# Bunderstack Library Deployment Blueprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, deterministic `bunderstack blueprint` command that turns a TanStack Start application's Bunderstack declaration into a committed, versioned `bunderstack.blueprint.yaml` containing every deployment-relevant database, storage, environment, realtime, worker, job, cron, and maintenance requirement.

**Architecture:** `app.manifest` remains the runtime source of truth, but advances to manifest v3 so it can describe migrations, logical tables, environment scopes, email requirements, and background maintenance without provider credentials. A public `bunderstack/blueprint` module validates and serializes a smaller provider-independent blueprint, while a Bun CLI imports the app under a fully inert introspection mode, discovers the configured entrypoint, detects the migration mode from disk, and atomically writes or checks the committed YAML. TanStack Start is the supported application lifecycle for this release; Bunderhost consumption is deliberately a later plan.

**Tech Stack:** Bun 1.3+, TypeScript, `bun:test`, Zod 4, YAML 2.9, Drizzle metadata, TanStack Start package conventions.

## Global Constraints

- Use Bun for every install, script, CLI, and test command.
- This plan changes only the Bunderstack repository; do not modify Bunderhost or HRBreakers.
- The public artifact is `bunderstack.blueprint.yaml`, stored beside the deployable application's `package.json`.
- TanStack Start is the only application framework accepted by blueprint v1; the package must depend on `@tanstack/react-start` and define non-empty `build` and `start` scripts.
- Entry resolution order is CLI `--entry`, `package.json#bunderstack.entry`, then `src/bunderstack.ts`.
- Queue jobs require a non-empty `worker` package script and produce `background.worker.required: true`.
- The blueprint describes provider-independent requirements only. Never serialize database URLs, auth tokens, S3 endpoints, access keys, Redis URLs, auth secrets, environment values, or provider choices.
- Include logical and system table names for discovery, but keep committed Drizzle migrations authoritative for physical schema and DDL.
- Include environment key, requiredness, and server/client scope. Never infer arbitrary `process.env` reads; document that hosting-relevant application variables must be declared through Bunderstack's `env` option.
- Platform-owned bindings such as database credentials, object-storage credentials, `AUTH_SECRET`, `REDIS_URL`, and `BUNDERSTACK_CRON_SECRET` are derived from resource declarations and are not duplicated as user environment entries.
- Include Bunderstack maintenance schedules in the blueprint; storage sweep must no longer be invisible to a host.
- The generator must be deterministic: stable field order, stable collection sorting, YAML 1.2, quoted cron expressions, final newline, no anchors, aliases, merge keys, or custom tags.
- `--check` must perform no writes and fail when the committed artifact differs byte-for-byte from newly generated output.
- A failed write or generation must preserve the previous blueprint byte-for-byte.
- `BUNDERSTACK_INTROSPECT=1` must prevent database/Redis connections, migration or schema-push work, queue polling, cron ticks, and process listeners.
- Keep introspection local to the developer/CI trust boundary. Bunderhost will later consume the static YAML without importing application code.
- Preserve the existing dirty worktree. At execution time use `superpowers:using-git-worktrees` before changing implementation files.
- This plan supersedes `docs/superpowers/plans/2026-07-31-committed-blueprint-generator.md`; do not execute both plans.

---

## File Structure

- Modify `packages/bunderstack/src/manifest.ts`
  - Own manifest v3 types and pure runtime declaration construction.
- Modify `packages/bunderstack/src/manifest.test.ts`
  - Prove manifest v3 database, environment, email, storage, realtime, and background metadata.
- Modify `packages/bunderstack/src/index.ts`
  - Pass resolved deployment metadata into the manifest and make runtime starters inert during introspection.
- Modify `packages/bunderstack/src/app-env.test.ts`
  - Prove the public app exposes the complete v3 declaration offline.
- Modify `packages/bunderstack/src/jobs/integration.test.ts`
  - Prove worker and cron starters do no work during introspection.
- Modify `packages/bunderstack/src/provision.ts`
  - Return before reading provision internals when introspecting.
- Modify `packages/bunderstack/src/provision.test.ts`
  - Prove introspection performs no filesystem, Drizzle Kit, push, or migration work.
- Create `packages/bunderstack/src/blueprint.ts`
  - Own blueprint v1 types, strict parsing, manifest conversion, sorting, and canonical YAML.
- Create `packages/bunderstack/src/blueprint.test.ts`
  - Prove the public static contract and secret omissions.
- Create `packages/bunderstack/src/blueprint-generator.ts`
  - Own package discovery, entry resolution, introspection import, migration-mode detection, lifecycle cleanup, checking, and atomic replacement.
- Create `packages/bunderstack/src/blueprint-generator.test.ts`
  - Prove generator behavior using temporary TanStack application fixtures.
- Create `packages/bunderstack/src/cli.ts`
  - Own the `bunderstack blueprint` command and stable diagnostics.
- Create `packages/bunderstack/src/cli.test.ts`
  - Prove CLI parsing, exit codes, `--check`, and help output.
- Modify `packages/bunderstack/package.json`
  - Publish the CLI binary and `bunderstack/blueprint` module; add YAML runtime dependency.
- Modify `bun.lock`
  - Lock YAML and package metadata changes.
- Modify `examples/todo/package.json`
  - Add TanStack production lifecycle and blueprint scripts.
- Create `examples/todo/bunderstack.blueprint.yaml`
  - Dogfood the public artifact.
- Modify `packages/bunderstack/README.md`
  - Document generation, CI freshness, entry overrides, process separation, and platform bindings.
- Modify `README.md`
  - Replace executable host introspection guidance with the committed blueprint workflow.
- Modify `scripts/dependency-boundaries.test.ts`
  - Keep CLI-only filesystem/YAML dependencies out of the main runtime import graph.

---

### Task 1: Advance the Runtime Manifest to Deployment Manifest v3

**Files:**

- Modify: `packages/bunderstack/src/manifest.ts`
- Modify: `packages/bunderstack/src/manifest.test.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/app-env.test.ts`

**Interfaces:**

- Consumes: resolved database config, resolved buckets, user env schemas, email provider tag, realtime declaration, and job definitions.
- Produces: `BunderstackManifest` version 3 with this public shape:

```ts
export type ManifestEnvVar = {
  key: string
  required: boolean
  scope: 'server' | 'client'
}

export type BunderstackManifest = {
  version: 3
  database: {
    dialect: Dialect
    migrationsDirectory: string
    tables: { exportName: string; physicalName: string; system: boolean }[]
  }
  storage: {
    defaultBucket: string
    buckets: { name: string; visibility: 'public' | 'private' }[]
  }
  realtime: { required: boolean }
  environment: ManifestEnvVar[]
  background: {
    jobs: { name: string }[]
    cron: { name: string; schedule: string; timezone: 'UTC' }[]
    maintenance: {
      name: 'storage-sweep'
      schedule: '0 4 * * *'
      timezone: 'UTC'
    }[]
  }
}

export function parseManifest(value: unknown): BunderstackManifest
```

- [ ] **Step 1: Replace the manifest tests with v3 expectations**

Add tests that build a manifest with SQLite, two user tables, all internal tables, two buckets, Redis-backed realtime, one optional server variable, one required client variable, Resend email, one queue job, and one cron. Assert the complete nested value rather than isolated fields, including required `RESEND_API_KEY`. Add a second test proving collections are sorted by `physicalName`, bucket `name`, environment `key`, and background task `name`. Add strict parser tests rejecting manifest v2, unknown keys, duplicate names, unsafe migration paths, and invalid cron schedules.

```ts
expect(manifest.version).toBe(3)
expect(manifest.database).toEqual({
  dialect: 'sqlite',
  migrationsDirectory: './migrations',
  tables: [
    {
      exportName: '_system.files',
      physicalName: 'bunderstack_file_meta',
      system: true,
    },
    { exportName: 'posts', physicalName: 'app_posts', system: false },
  ],
})
expect(manifest.environment).toContainEqual({
  key: 'PUBLIC_SITE_NAME',
  required: true,
  scope: 'client',
})
expect(manifest.background.maintenance).toEqual([
  { name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' },
])
```

- [ ] **Step 2: Run manifest tests to verify RED**

Run:

```sh
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/app-env.test.ts
```

Expected: FAIL because the runtime still emits manifest v2 and lacks the nested deployment fields.

- [ ] **Step 3: Implement the v3 manifest model**

Refactor `buildManifest` to accept the additional stable inputs and add a strict `parseManifest(value: unknown)` validator used at every application-import boundary:

```ts
export function buildManifest(args: {
  schema: Record<string, unknown>
  dialect: Dialect
  migrationsDirectory: string
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  emailProvider: string | undefined
  realtime: boolean
  jobs: JobsDefs | undefined
}): BunderstackManifest
```

Create user table entries from `describeTables(args.schema)`. Add internal entries explicitly with export names `_system.jobs`, `_system.files`, and `_system.scheduledRuns`; do not depend on internal tables being present in the user's schema object. Convert `env.server` and `env.client` into one array with explicit scope. Determine requiredness with `schema.safeParse(undefined).success`, preserving current semantics. When `emailProvider` is `resend`, merge required server entry `RESEND_API_KEY`; when it is `smtp`, merge required server entry `SMTP_URL`; console and custom providers add nothing. Reject conflicting duplicate declarations instead of silently choosing one. Sort every emitted collection inside `buildManifest` so all consumers receive deterministic data.

- [ ] **Step 4: Wire v3 inputs from `createBunderstack`**

Change the call in `index.ts` to pass `config.database.migrations`. Remove `realtimeTransport` from the manifest contract: the artifact declares that shared realtime infrastructure is required, while the host later chooses and injects the actual transport. Keep `app.realtime.transport` unchanged for runtime diagnostics.

```ts
manifest: buildManifest({
  schema: options.schema,
  dialect,
  migrationsDirectory: config.database.migrations,
  storage: config.storage,
  envConfig: options.env as EnvConfigInput | undefined,
  emailProvider: emailProviderTag(options.email),
  realtime: Boolean(config.realtime),
  jobs: jobsDefs,
})
```

Update the bottom-level public export to `export { buildManifest, parseManifest } from './manifest'` so tooling does not duplicate v3 validation.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```sh
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/app-env.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: all commands exit 0 and no v2 field names remain in production code.

- [ ] **Step 6: Commit manifest v3**

```sh
git add packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts
git commit -m "feat(manifest): declare deployment requirements in v3"
```

---

### Task 2: Make All Introspection Paths Inert

**Files:**

- Modify: `packages/bunderstack/src/provision.ts`
- Modify: `packages/bunderstack/src/provision.test.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**

- Consumes: `process.env.BUNDERSTACK_INTROSPECT === '1'`.
- Produces: no-op provisioning and inert lifecycle handles without database access, timers, or process listeners.

- [ ] **Step 1: Add failing provisioning and runtime-starter tests**

Add a serial provisioning test that calls `provision({})` while introspecting; resolving proves it exits before private internals are read. Add an app integration test with one queue job and one cron, set introspection before construction, and assert all starter APIs return/resolve without invoking handlers.

```ts
function makeIntrospectionApp(onRun: () => void) {
  return createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({
        queued: j.job({ handler: async () => onRun() }),
        scheduled: j.cron({
          schedule: '* * * * *',
          handler: async () => onRun(),
        }),
      }),
  })
}

test.serial(
  'introspection makes provisioning and background starters inert',
  async () => {
    const previous = process.env.BUNDERSTACK_INTROSPECT
    process.env.BUNDERSTACK_INTROSPECT = '1'
    let runs = 0
    try {
      await expect(provision({})).resolves.toBeUndefined()
      const app = await makeJobsApp(() => {
        runs += 1
      })
      const worker = await app.startWorker()
      const cron = await app.startCronScheduler()
      await app.runWorker()
      expect(runs).toBe(0)
      await worker.close()
      await cron.close()
      await app.close()
    } finally {
      if (previous === undefined) delete process.env.BUNDERSTACK_INTROSPECT
      else process.env.BUNDERSTACK_INTROSPECT = previous
    }
  },
)
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```sh
bun test packages/bunderstack/src/provision.test.ts packages/bunderstack/src/jobs/integration.test.ts
```

Expected: provisioning throws on the fake app or a starter polls/ticks.

- [ ] **Step 3: Add the earliest possible provisioning return**

Make the first executable line of `provision()`:

```ts
if (process.env.BUNDERSTACK_INTROSPECT === '1') return
```

The return must precede `PROVISION_INTERNALS`, filesystem access, migration journal detection, and any dynamic Drizzle Kit import.

- [ ] **Step 4: Return inert background handles**

Capture `const introspect = process.env.BUNDERSTACK_INTROSPECT === '1'` once during app construction. In `startWorker`, return `{ closed: Promise.resolve(), close: async () => {} }` before lifecycle registration or queue access. In `startCronScheduler`, return `{ tick: async () => {}, close: async () => {} }` before validating cron definitions or creating timers. In `runWorker`, return immediately before realtime safety checks and signal handlers. Each inert close/tick operation must be idempotent and must not register with the application lifecycle.

- [ ] **Step 5: Run lifecycle regression tests**

Run:

```sh
bun test packages/bunderstack/src/provision.test.ts packages/bunderstack/src/provision.integration.test.ts packages/bunderstack/src/provision.pg.integration.test.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/lifecycle.test.ts
```

Expected: all tests pass; non-introspection worker, cron, provisioning, and shutdown behavior remains unchanged.

- [ ] **Step 6: Commit introspection safety**

```sh
git add packages/bunderstack/src/provision.ts packages/bunderstack/src/provision.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/jobs/integration.test.ts
git commit -m "fix: make deployment introspection side effect free"
```

---

### Task 3: Define the Public Blueprint v1 Contract

**Files:**

- Create: `packages/bunderstack/src/blueprint.ts`
- Create: `packages/bunderstack/src/blueprint.test.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: `BunderstackManifest` v3 plus generator-resolved application and migration metadata.
- Produces:

```ts
export type MigrationMode = 'migrations' | 'push'

export type BunderstackBlueprint = {
  version: 1
  generator: { name: 'bunderstack'; version: string }
  application: {
    framework: 'tanstack-start'
    scripts: { build: 'build'; start: 'start'; worker?: 'worker' }
  }
  bunderstack: { entry: string; manifestVersion: 3 }
  resources: {
    database: BunderstackManifest['database'] & { migrationMode: MigrationMode }
    storage: BunderstackManifest['storage']
    realtime?: { required: true }
  }
  environment: BunderstackManifest['environment']
  background: BunderstackManifest['background'] & {
    worker: { required: boolean }
  }
}

export function parseBlueprint(value: unknown): BunderstackBlueprint
export function parseBlueprintYaml(source: string): BunderstackBlueprint
export function blueprintFromManifest(args: {
  manifest: BunderstackManifest
  generatorVersion: string
  entry: string
  migrationMode: MigrationMode
}): BunderstackBlueprint
export function serializeBlueprint(value: BunderstackBlueprint): string
```

- [ ] **Step 1: Add YAML as a package runtime dependency**

Run:

```sh
bun add --cwd packages/bunderstack yaml@^2.9.0
```

Expected: `yaml` appears under `dependencies` in `packages/bunderstack/package.json` and `bun.lock` changes.

- [ ] **Step 2: Write strict contract and serialization tests**

Create a complete manifest fixture. Assert conversion includes tables, migration metadata, storage buckets, env scope, realtime requirement, worker requirement, jobs, cron, and maintenance. Assert `parseBlueprint` rejects unknown keys, duplicate env keys, duplicate bucket/task names, unsafe entry paths, unsupported versions, and invalid cron expressions using the existing `parseCron` helper.

Add a canonical YAML snapshot with deliberately unsorted fixture inputs and assert:

```ts
const yaml = serializeBlueprint(blueprint)
expect(yaml).toEndWith('\n')
expect(yaml).not.toContain('DATABASE_URL')
expect(yaml).not.toContain('SECRET_ACCESS_KEY')
expect(parseBlueprintYaml(yaml)).toEqual(blueprint)
expect(serializeBlueprint(parseBlueprintYaml(yaml))).toBe(yaml)
```

- [ ] **Step 3: Run contract tests to verify RED**

Run:

```sh
bun test packages/bunderstack/src/blueprint.test.ts
```

Expected: FAIL because the public module does not exist.

- [ ] **Step 4: Implement the strict schema and canonical serializer**

Use Zod `.strict()` at every object boundary. Normalize entry paths to forward slashes and reject absolute paths, `..` segments, empty segments, NUL bytes, and paths outside the application root. Sort collections during conversion, then configure YAML with aliases disabled and deterministic quoting. After serialization, parse the generated text through `parseBlueprintYaml` before returning it.

Do not expose manifest v3's runtime-only implementation details. Blueprint conversion may copy only fields present in the declared v1 type.

- [ ] **Step 5: Export the public parser module**

Add:

```json
"./blueprint": "./src/blueprint.ts"
```

to package exports. Do not export filesystem generator functions from this entry; Bunderhost will later be able to depend on the pure parser without pulling CLI code into its server graph.

- [ ] **Step 6: Run focused tests and package typecheck**

Run:

```sh
bun test packages/bunderstack/src/blueprint.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the public contract**

```sh
git add packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/package.json bun.lock
git commit -m "feat(blueprint): publish deployment contract v1"
```

---

### Task 4: Build the Application-Aware Blueprint Generator

**Files:**

- Create: `packages/bunderstack/src/blueprint-generator.ts`
- Create: `packages/bunderstack/src/blueprint-generator.test.ts`

**Interfaces:**

- Consumes: a TanStack application directory and optional entry/output overrides.
- Produces:

```ts
export type GenerateBlueprintOptions = {
  directory: string
  entry?: string
  output?: string
  check?: boolean
}

export type GenerateBlueprintResult = {
  path: string
  blueprint: BunderstackBlueprint
  source: string
  changed: boolean
}

export async function generateBlueprint(
  options: GenerateBlueprintOptions,
): Promise<GenerateBlueprintResult>
```

- [ ] **Step 1: Write temporary-fixture generator tests**

Build fixtures under `mkdtemp` with a minimal `package.json`, `src/bunderstack.ts`, and fake exported app manifest. Cover:

- default entry resolution;
- `package.json#bunderstack.entry` resolving `src/bunderstack/index.ts`;
- CLI entry override winning over package metadata;
- TanStack dependency plus non-empty `build` and `start` validation;
- queue jobs requiring `worker`;
- committed migration journal producing `migrationMode: migrations`;
- absent journal producing `migrationMode: push`;
- unsupported/missing app manifest;
- app `close()` called exactly once after a successful import;
- environment and working directory restored after success and failure;
- check success, check mismatch, atomic replacement, and preservation after failure.

Use dependency injection for `importModule` and `rename` so tests never need to execute arbitrary fixture code merely to observe cleanup and atomic behavior.

- [ ] **Step 2: Run generator tests to verify RED**

Run:

```sh
bun test packages/bunderstack/src/blueprint-generator.test.ts
```

Expected: FAIL because `generateBlueprint` does not exist.

- [ ] **Step 3: Implement package and entry discovery**

Read and parse the application `package.json` as `unknown`. Validate:

```ts
type AppPackage = {
  version?: string
  scripts: { build: string; start: string; worker?: string }
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
  bunderstack?: { entry?: string }
}
```

Accept `@tanstack/react-start` from dependencies or devDependencies. Resolve the selected entry and output against the application directory, then prove both remain inside it after `realpath`-aware normalization. Require the entry file to exist before changing environment state.

- [ ] **Step 4: Implement scoped introspection import and cleanup**

Set only `BUNDERSTACK_INTROSPECT=1`, dynamically import the entry through an absolute file URL with a unique query string, validate `module.app.manifest` as manifest v3, and always call `await module.app.close()` when available. Restore the exact previous environment value in `finally`; do not change `cwd` globally.

Read the generator version from the installed Bunderstack package metadata, not the application package version.

- [ ] **Step 5: Detect migration mode and convert**

Resolve `manifest.database.migrationsDirectory` from the application directory. If `<directory>/meta/_journal.json` exists, use `migrations`; otherwise use `push`. The generator must report the mode accurately; production enforcement belongs to the later Bunderhost plan.

- [ ] **Step 6: Implement checking and atomic replacement**

For `check: true`, compare canonical source with the current output and throw a typed `BlueprintCheckError` when missing or stale. For writes, create a temporary sibling with mode `0o600`, flush/close it, rename it over the destination, and clean up only that exact temporary path in `finally`. Never remove or truncate the destination before rename succeeds.

- [ ] **Step 7: Run focused tests**

Run:

```sh
bun test packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/app-env.test.ts
```

Expected: all tests pass, including preservation of an existing output after forced rename failure.

- [ ] **Step 8: Commit the generator**

```sh
git add packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts
git commit -m "feat(blueprint): generate artifacts from TanStack apps"
```

---

### Task 5: Publish the `bunderstack blueprint` CLI

**Files:**

- Create: `packages/bunderstack/src/cli.ts`
- Create: `packages/bunderstack/src/cli.test.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `scripts/dependency-boundaries.test.ts`

**Interfaces:**

- Consumes: `generateBlueprint()` and these commands:

```text
bunderstack blueprint [directory] [--entry <path>] [--output <path>]
bunderstack blueprint [directory] --check [--entry <path>] [--output <path>]
bunderstack --help
bunderstack --version
```

- Produces:

```ts
export type CliIo = {
  stdout(message: string): void
  stderr(message: string): void
}

export async function runCli(
  args: string[],
  io: CliIo,
  generate?: typeof generateBlueprint,
): Promise<number>
```

Exit 0 on generation/current check, exit 1 on stale artifact or actionable application error, and exit 2 on invalid CLI syntax.

- [ ] **Step 1: Write CLI tests around an injected runner**

Export `runCli(args, io, generate = generateBlueprint): Promise<number>` so tests can capture stdout/stderr and inject a fake generator. Assert exact concise messages:

```text
Generated bunderstack.blueprint.yaml
bunderstack.blueprint.yaml is current
bunderstack.blueprint.yaml is missing or stale; run `bunderstack blueprint`
```

Assert help documents entry precedence, package metadata, `--check`, and TanStack Start requirements. Assert unknown commands, missing flag values, and repeated mutually exclusive arguments exit 2.

- [ ] **Step 2: Run CLI tests to verify RED**

Run:

```sh
bun test packages/bunderstack/src/cli.test.ts
```

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement the Bun executable**

Start `cli.ts` with `#!/usr/bin/env bun`. Keep argument parsing dependency-free. Invoke the process only when the module is the executable entry so importing it in tests has no process side effect:

```ts
if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  })
  process.exit(exitCode)
}
```

- [ ] **Step 4: Publish the binary without polluting the main runtime graph**

Add:

```json
"bin": {
  "bunderstack": "./src/cli.ts"
}
```

Keep `blueprint-generator.ts`, `yaml`, and filesystem imports unreachable from `import 'bunderstack'`. Extend the dependency-boundary test to build or trace the main entry and reject `blueprint-generator`, `node:fs`, and CLI-only YAML modules in that graph.

- [ ] **Step 5: Run CLI and boundary tests**

Run:

```sh
bun test packages/bunderstack/src/cli.test.ts scripts/dependency-boundaries.test.ts scripts/bundle-boundaries.test.ts
bun packages/bunderstack/src/cli.ts --help
```

Expected: tests pass and help exits 0 without creating files.

- [ ] **Step 6: Commit the CLI**

```sh
git add packages/bunderstack/src/cli.ts packages/bunderstack/src/cli.test.ts packages/bunderstack/package.json scripts/dependency-boundaries.test.ts
git commit -m "feat(cli): publish bunderstack blueprint command"
```

---

### Task 6: Dogfood the Blueprint in the TanStack Todo App

**Files:**

- Modify: `examples/todo/package.json`
- Create: `examples/todo/bunderstack.blueprint.yaml`
- Modify: `examples/todo/src/bunderstack.ts`
- Modify: `examples/todo/src/worker.ts`

**Interfaces:**

- Consumes: public CLI, side-effect-free declaration entry, TanStack Start production build output.
- Produces: a representative committed artifact and separate web/worker ownership.

- [ ] **Step 1: Add package lifecycle and freshness scripts**

Define non-empty scripts:

```json
{
  "start": "bun .output/server/index.mjs",
  "worker": "bun src/worker.ts",
  "blueprint": "bunderstack blueprint",
  "blueprint:check": "bunderstack blueprint --check"
}
```

Keep the existing TanStack `build` script. Do not start a queue worker from the web declaration module.

- [ ] **Step 2: Prove the declaration entry is import-safe**

Move any web-only startup out of `src/bunderstack.ts`. It may construct and export `app` and call `provision(app)` because Task 2 makes provisioning inert during generation, but it must not call `startWorker`, `runWorker`, `startCronScheduler`, or install signal handlers. Keep `src/worker.ts` as the only production queue runner using `await app.runWorker()`.

- [ ] **Step 3: Generate the first committed artifact**

Run:

```sh
bun run --cwd examples/todo blueprint
```

Expected: `examples/todo/bunderstack.blueprint.yaml` contains TanStack lifecycle metadata, SQLite database/table declarations, logical bucket declarations, env scopes, realtime requirement, worker/jobs, cron, and storage-sweep maintenance, with no values or credentials.

- [ ] **Step 4: Verify freshness and production build**

Run:

```sh
bun run --cwd examples/todo blueprint:check
bun run --cwd examples/todo build
bunx tsc --noEmit -p examples/todo/tsconfig.json
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the dogfood app**

```sh
git add examples/todo/package.json examples/todo/bunderstack.blueprint.yaml examples/todo/src/bunderstack.ts examples/todo/src/worker.ts
git commit -m "example(todo): commit deployment blueprint"
```

---

### Task 7: Document the Library-to-Host Contract

**Files:**

- Modify: `packages/bunderstack/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-31-committed-blueprint-generator-design.md`

**Interfaces:**

- Consumes: the final public CLI, blueprint v1, manifest v3, and TanStack lifecycle conventions.
- Produces: documentation Bunderstack users and the later Bunderhost plan can treat as authoritative.

- [ ] **Step 1: Replace executable introspection instructions**

Remove the documented recommendation to set `BUNDERSTACK_INTROSPECT=1` and import application code manually. Document:

```sh
bunx bunderstack blueprint
bunx bunderstack blueprint --check
```

Explain that `BUNDERSTACK_INTROSPECT` is an internal generator mechanism, not a user-facing hosting API.

- [ ] **Step 2: Document the application contract**

State that hosted v1 applications use TanStack Start, export `app`, mount `app.handler`, define `build` and `start`, and add `worker` only when queue jobs exist. Show both entry layouts:

```json
{
  "bunderstack": { "entry": "src/bunderstack/index.ts" }
}
```

and conventional `src/bunderstack.ts`. Explain entry precedence and that app declaration imports must not perform unrelated external side effects.

- [ ] **Step 3: Document resource and environment ownership**

List the blueprint fields and explain:

- one primary managed database per app environment;
- one physical S3-compatible backend with logical bucket prefixes;
- Redis required when realtime is declared for hosted multi-process/multi-instance runtimes;
- Bunderstack jobs use a separate worker process;
- cron and storage maintenance are signed platform HTTP deliveries;
- committed migrations remain authoritative;
- `migrationMode: push` is development-capable but may be rejected by a production host;
- hosting-relevant variables must be declared through `env`, while provider credentials and platform secrets never appear in YAML.

- [ ] **Step 4: Mark the earlier prototype design as superseded**

Add a short status note at the top of the July 31 design pointing to this implementation plan. Do not rewrite its historical decisions.

- [ ] **Step 5: Run documentation-sensitive tests**

Run:

```sh
bun test packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/cli.test.ts scripts/dependency-boundaries.test.ts
```

Expected: all commands exit 0 and examples in help/tests match the README contract.

- [ ] **Step 6: Commit documentation**

```sh
git add packages/bunderstack/README.md README.md docs/superpowers/specs/2026-07-31-committed-blueprint-generator-design.md
git commit -m "docs: define the static deployment blueprint workflow"
```

---

### Task 8: Verify the Publishable Library End to End

**Files:**

- Modify only if verification exposes a defect in files already owned by Tasks 1-7.

**Interfaces:**

- Consumes: completed manifest v3, introspection safety, blueprint module, generator, CLI, and todo artifact.
- Produces: evidence that the library is ready for the separate Bunderhost consumption plan.

- [ ] **Step 1: Run the complete Bunderstack package tests**

```sh
bun test --cwd packages/bunderstack
```

Expected: all tests pass with zero unhandled lifecycle resources.

- [ ] **Step 2: Run workspace boundaries and typechecks**

```sh
bun run test:boundaries
bun run test:bundles
bun run typecheck:all
```

Expected: all commands exit 0; the main runtime graph remains free of generator filesystem code.

- [ ] **Step 3: Prove deterministic generation**

```sh
bun run --cwd examples/todo blueprint:check
bun run --cwd examples/todo blueprint
bun run --cwd examples/todo blueprint:check
git diff --exit-code -- examples/todo/bunderstack.blueprint.yaml
```

Expected: both checks pass and regeneration produces no diff.

- [ ] **Step 4: Test the packed package binary**

Pack `packages/bunderstack` into a temporary directory, install that tarball into a temporary minimal TanStack fixture with Bun, and run:

```sh
bunx bunderstack --version
bunx bunderstack blueprint
bunx bunderstack blueprint --check
```

Expected: the installed binary resolves raw TypeScript through Bun, generates a valid artifact, and the check passes. Keep all temporary files outside the repository and remove only the exact temporary directory afterward.

- [ ] **Step 5: Inspect final scope**

```sh
git status --short
git diff --stat HEAD~7..HEAD
```

Expected: only files named in this plan changed; pre-existing `.claude/`, `data.db`, and unrelated plan files remain untouched.

- [ ] **Step 6: Commit verification-only fixes if needed**

If Steps 1-5 required a code correction, rerun the failing command plus Steps 1-3, stage only the specific implementation and test files changed by that correction, then commit:

```sh
git commit -m "fix(blueprint): address publish verification"
```

If no corrections were needed, do not create an empty commit.

---

## Completion Criteria

- `app.manifest` is version 3 and fully describes deployment-relevant database, tables, migrations directory, storage, env scopes, realtime, jobs, cron, and maintenance.
- Introspection imports cannot provision, poll jobs, tick cron, connect Redis, or install process listeners.
- `bunderstack/blueprint` is a public pure parser/serializer contract.
- `bunderstack blueprint` is a published Bun CLI with configurable entry resolution, atomic generation, and `--check`.
- The committed YAML is deterministic and contains no secret values or provider credentials.
- TanStack Start `build`, `start`, and optional `worker` scripts are validated.
- The todo TanStack application dogfoods the artifact and passes its freshness check.
- Full package tests, dependency boundaries, bundle boundaries, typechecks, packed-package CLI smoke tests, and deterministic regeneration pass.
- No Bunderhost changes are included; its consumer/provisioning plan begins only after these criteria are met.
