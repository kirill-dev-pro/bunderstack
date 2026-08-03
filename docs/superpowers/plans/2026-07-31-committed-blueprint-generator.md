# Committed Blueprint Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal Bun script that imports a local Bunderstack application in introspection mode and atomically generates a deterministic, committed `bunderstack.blueprint.yaml`.

**Architecture:** Keep the blueprint model and YAML serialization pure, isolate application import/package validation/filesystem work in a generator module, and keep the executable script as a thin wrapper. Reuse `app.manifest` as the discovery source, make `provision(app)` a no-op during introspection, and dogfood the generator on the todo example.

**Tech Stack:** Bun 1.3+, TypeScript, `bun:test`, Bunderstack manifest v2, `yaml` 2.9, Bun file APIs, Node `fs/promises` only for atomic rename/cleanup.

## Global Constraints

- Use Bun for every install, script, and test command.
- The prototype is internal: do not add a package export, published binary, root package script, public CLI name, or compatibility guarantee.
- `bunderstack.blueprint.yaml` lives beside the deployable application's `package.json`.
- All paths are relative to the blueprint directory.
- The Bunderstack declaration entry is exactly `src/bunderstack.ts`.
- Application lifecycle is conventional and absent from YAML: `bun install --frozen-lockfile`, `bun run build`, and `bun run start`.
- The generator requires non-empty `build` and `start` package scripts.
- Queue jobs require a non-empty `worker` package script; their runtime command is conventionally `bun run worker`.
- Environment entries contain only `key` and `required`.
- Do not emit database tables, environment values, credentials, provider selections, host-framework metadata, web processes, application commands, integrity hashes, or platform maintenance tasks.
- Database resources expose only the manifest schema dialect (`sqlite` or `pg`).
- Provider selection remains a Bunderhost dashboard concern and is outside this implementation.
- The generated YAML must be deterministic and contain no anchors, aliases, merge keys, or custom tags.
- A failed generation must preserve any existing blueprint byte-for-byte.
- `BUNDERSTACK_INTROSPECT=1` must prevent database/Redis connections and make `provision(app)` return without filesystem, Drizzle Kit, or migration work.
- Before implementation, use `superpowers:using-git-worktrees`; the current main checkout contains unrelated user changes.

---

## File Structure

- Modify `packages/bunderstack/src/provision.ts`
  - Own the introspection early return for provisioning.
- Modify `packages/bunderstack/src/provision.test.ts`
  - Prove `provision()` exits before reading app internals in introspection mode.
- Create `scripts/blueprint/model.ts`
  - Own the prototype blueprint types, runtime manifest validation, manifest-to-blueprint conversion, sorting, and YAML serialization.
- Create `scripts/blueprint/model.test.ts`
  - Prove the contract shape, omissions, ordering, and YAML safety.
- Create `scripts/blueprint/generator.ts`
  - Own package/entry validation, scoped introspection import, lifecycle cleanup, blueprint preparation, and atomic replacement.
- Create `scripts/blueprint/generator.test.ts`
  - Prove success, actionable failures, worker validation, environment/cwd restoration, atomic replacement, and failure preservation.
- Create `scripts/generate-blueprint.ts`
  - Thin executable wrapper around `generateBlueprint()`.
- Create `scripts/generate-blueprint.test.ts`
  - Prove CLI exit behavior and that the committed todo blueprint is current.
- Modify `examples/todo/package.json`
  - Add the conventional production `start` script required by generation and Bunderhost.
- Create `examples/todo/bunderstack.blueprint.yaml`
  - Dogfood the generated contract on the most feature-complete example.
- Modify `package.json`
  - Add the internal `yaml` serializer as a root dev dependency.
- Modify `bun.lock`
  - Lock the exact transitive dependency graph produced by Bun.

---

### Task 1: Make Provisioning Introspection-Safe

**Files:**

- Modify: `packages/bunderstack/src/provision.ts:87`
- Modify: `packages/bunderstack/src/provision.test.ts`

**Interfaces:**

- Consumes: `process.env.BUNDERSTACK_INTROSPECT`.
- Produces: `provision(app, options)` resolving immediately when the flag equals `'1'`; later generator tasks rely on importing entries that call `await provision(app)`.

- [ ] **Step 1: Write the failing no-op test**

Update the provision import and add a serial test because it temporarily changes
process-global environment state:

```ts
import { provision, provisionSchema } from './provision'

test.serial('provision is a no-op during introspection', async () => {
  const previous = process.env.BUNDERSTACK_INTROSPECT
  process.env.BUNDERSTACK_INTROSPECT = '1'

  try {
    await expect(provision({})).resolves.toBeUndefined()
  } finally {
    if (previous === undefined) {
      delete process.env.BUNDERSTACK_INTROSPECT
    } else {
      process.env.BUNDERSTACK_INTROSPECT = previous
    }
  }
})
```

Passing `{}` is intentional: without the early return, `provision()` reads the
private app internals and throws. Resolving proves introspection exits before
filesystem, Drizzle Kit, adapter migration, or schema-push work can begin.

- [ ] **Step 2: Run the test to verify RED**

Run:

```sh
bun test packages/bunderstack/src/provision.test.ts
```

Expected: FAIL with `provision() expects the app returned by createBunderstack()`.

- [ ] **Step 3: Add the minimal early return**

At the first line of `provision()`:

```ts
export async function provision(
  app: object,
  options?: { force?: boolean },
): Promise<void> {
  if (process.env.BUNDERSTACK_INTROSPECT === '1') return

  const internals = (app as WithProvisionInternals)[PROVISION_INTERNALS]
  // Existing implementation continues unchanged.
}
```

- [ ] **Step 4: Run focused and regression tests**

Run:

```sh
bun test packages/bunderstack/src/provision.test.ts packages/bunderstack/src/provision.integration.test.ts packages/bunderstack/src/provision.pg.integration.test.ts
```

Expected: all provisioning tests pass. Normal provisioning tests continue to
push or migrate because they do not set the introspection flag.

- [ ] **Step 5: Commit**

```sh
git add packages/bunderstack/src/provision.ts packages/bunderstack/src/provision.test.ts
git commit -m "fix: skip provisioning during introspection"
```

---

### Task 2: Define and Serialize the Minimal Blueprint

**Files:**

- Create: `scripts/blueprint/model.ts`
- Create: `scripts/blueprint/model.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: runtime `unknown` manifest values and the subset of Bunderstack
  manifest v2 required by the blueprint.
- Produces:

```ts
export type BunderstackBlueprint
export type BlueprintManifest
export function parseBunderstackManifest(value: unknown): BlueprintManifest
export function blueprintFromManifest(
  manifest: BlueprintManifest,
  entry?: string,
): BunderstackBlueprint
export function serializeBlueprint(
  blueprint: BunderstackBlueprint,
): string
```

- [ ] **Step 1: Add the YAML dependency**

Run from the repository root:

```sh
bun add --dev yaml@^2.9.0
```

Expected: root `package.json` contains `yaml` in `devDependencies`, `bun.lock`
is updated, and no package-level manifest is modified.

- [ ] **Step 2: Write the failing model tests**

Create `scripts/blueprint/model.test.ts` with a complete manifest fixture:

```ts
import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

import type { BunderstackManifest } from '../../packages/bunderstack/src/manifest'

import {
  blueprintFromManifest,
  parseBunderstackManifest,
  serializeBlueprint,
} from './model'

const manifest: BunderstackManifest = {
  version: 2,
  dialect: 'sqlite',
  tables: ['todos', 'user'],
  tableMap: { todos: 'todos', user: 'user' },
  systemTables: {
    jobs: '_bunderstack_jobs',
    files: 'bunderstack_file_meta',
    scheduledRuns: '_bunderstack_cron_runs',
  },
  defaultBucket: 'images',
  buckets: [{ name: 'images', visibility: 'private' }],
  realtime: true,
  realtimeTransport: 'redis',
  env: {
    server: [{ key: 'NOTIFY_COMPLETED', required: false }],
    client: [{ key: 'PUBLIC_APP_NAME', required: false }],
  },
  background: {
    jobs: [{ name: 'celebrateBoardComplete' }],
    cron: [
      {
        name: 'archiveDoneTodos',
        schedule: '* * * * *',
        timezone: 'UTC',
      },
    ],
    maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *' }],
  },
}

describe('blueprintFromManifest', () => {
  test('keeps only the provider-independent deployment shape', () => {
    const blueprint = blueprintFromManifest(manifest)

    expect(blueprint).toEqual({
      version: 1,
      bunderstack: { entry: 'src/bunderstack.ts' },
      resources: {
        database: { dialect: 'sqlite' },
        storage: {
          buckets: [{ name: 'images', visibility: 'private' }],
        },
        realtime: { required: true },
      },
      environment: [
        { key: 'NOTIFY_COMPLETED', required: false },
        { key: 'PUBLIC_APP_NAME', required: false },
      ],
      background: {
        worker: { required: true },
        jobs: [{ name: 'celebrateBoardComplete' }],
        cron: [
          {
            name: 'archiveDoneTodos',
            schedule: '* * * * *',
            timezone: 'UTC',
          },
        ],
      },
    })
  })

  test('omits disabled realtime and emits empty collections', () => {
    const blueprint = blueprintFromManifest({
      ...manifest,
      realtime: false,
      realtimeTransport: 'disabled',
      env: { server: [], client: [] },
      background: { jobs: [], cron: [], maintenance: [] },
    })

    expect(blueprint.resources).not.toHaveProperty('realtime')
    expect(blueprint.environment).toEqual([])
    expect(blueprint.background).toEqual({
      worker: { required: false },
      jobs: [],
      cron: [],
    })
  })

  test('sorts all named collections for stable output', () => {
    const blueprint = blueprintFromManifest({
      ...manifest,
      buckets: [
        { name: 'zeta', visibility: 'private' },
        { name: 'alpha', visibility: 'public' },
      ],
      env: {
        server: [
          { key: 'Z_KEY', required: true },
          { key: 'A_KEY', required: false },
        ],
        client: [],
      },
      background: {
        jobs: [{ name: 'zJob' }, { name: 'aJob' }],
        cron: [
          { name: 'zCron', schedule: '0 3 * * *', timezone: 'UTC' },
          { name: 'aCron', schedule: '0 2 * * *', timezone: 'UTC' },
        ],
        maintenance: [],
      },
    })

    expect(blueprint.resources.storage.buckets.map(({ name }) => name)).toEqual(
      ['alpha', 'zeta'],
    )
    expect(blueprint.environment.map(({ key }) => key)).toEqual([
      'A_KEY',
      'Z_KEY',
    ])
    expect(blueprint.background.jobs.map(({ name }) => name)).toEqual([
      'aJob',
      'zJob',
    ])
    expect(blueprint.background.cron.map(({ name }) => name)).toEqual([
      'aCron',
      'zCron',
    ])
  })
})

test('serializeBlueprint emits deterministic safe YAML', () => {
  const unsafeManifest = structuredClone(manifest) as BunderstackManifest
  unsafeManifest.env.server[0] = Object.assign(
    {},
    unsafeManifest.env.server[0],
    { value: 'must-not-appear' },
  )
  const blueprint = blueprintFromManifest(unsafeManifest)
  const first = serializeBlueprint(blueprint)
  const second = serializeBlueprint(blueprint)

  expect(second).toBe(first)
  expect(parse(first)).toEqual(blueprint)
  expect(first).not.toContain('tables:')
  expect(first).not.toContain('maintenance:')
  expect(first).not.toContain('must-not-appear')
  expect(first).not.toMatch(/&a\d+/)
  expect(first).not.toMatch(/\*a\d+/)
  expect(first.endsWith('\n')).toBe(true)
})

test('parseBunderstackManifest rejects unsupported values', () => {
  expect(() => parseBunderstackManifest(null)).toThrow(/manifest/i)
  expect(() => parseBunderstackManifest({ version: 1 })).toThrow(/version 2/i)
  expect(() =>
    parseBunderstackManifest({ ...manifest, dialect: 'mysql' }),
  ).toThrow(/dialect/i)
})
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```sh
bun test scripts/blueprint/model.test.ts
```

Expected: FAIL because `scripts/blueprint/model.ts` does not exist.

- [ ] **Step 4: Implement the contract and runtime manifest parser**

Create `scripts/blueprint/model.ts` with these public types:

```ts
import { stringify } from 'yaml'

import type { BunderstackManifest } from '../../packages/bunderstack/src/manifest'

export const BUNDERSTACK_ENTRY = 'src/bunderstack.ts' as const

export type BlueprintManifest = {
  version: 2
  dialect: BunderstackManifest['dialect']
  buckets: BunderstackManifest['buckets']
  realtime: BunderstackManifest['realtime']
  env: BunderstackManifest['env']
  background: Pick<BunderstackManifest['background'], 'jobs' | 'cron'>
}

type BlueprintBucket = {
  name: string
  visibility: 'public' | 'private'
}

type BlueprintEnv = {
  key: string
  required: boolean
}

type BlueprintJob = { name: string }

type BlueprintCron = {
  name: string
  schedule: string
  timezone: 'UTC'
}

export type BunderstackBlueprint = {
  version: 1
  bunderstack: { entry: string }
  resources: {
    database: { dialect: 'sqlite' | 'pg' }
    storage: { buckets: BlueprintBucket[] }
    realtime?: { required: true }
  }
  environment: BlueprintEnv[]
  background: {
    worker: { required: boolean }
    jobs: BlueprintJob[]
    cron: BlueprintCron[]
  }
}
```

Add focused guards for every manifest property consumed by the mapper:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new Error(`[bunderstack blueprint] invalid app.manifest: ${message}`)
}

function hasNamedEntries(value: unknown): value is { name: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        entry.name.length > 0,
    )
  )
}

export function parseBunderstackManifest(value: unknown): BlueprintManifest {
  if (!isRecord(value)) invalid('expected an object')
  if (value.version !== 2) invalid('expected manifest version 2')
  if (value.dialect !== 'sqlite' && value.dialect !== 'pg') {
    invalid('expected dialect "sqlite" or "pg"')
  }
  if (
    !Array.isArray(value.buckets) ||
    !value.buckets.every(
      (bucket) =>
        isRecord(bucket) &&
        typeof bucket.name === 'string' &&
        (bucket.visibility === 'public' || bucket.visibility === 'private'),
    )
  ) {
    invalid('expected valid buckets')
  }
  if (typeof value.realtime !== 'boolean') {
    invalid('expected realtime boolean')
  }
  if (!isRecord(value.env)) invalid('expected env object')
  for (const section of ['server', 'client'] as const) {
    const entries = value.env[section]
    if (
      !Array.isArray(entries) ||
      !entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.key === 'string' &&
          typeof entry.required === 'boolean',
      )
    ) {
      invalid(`expected valid env.${section}`)
    }
  }
  if (!isRecord(value.background)) invalid('expected background object')
  if (!hasNamedEntries(value.background.jobs)) {
    invalid('expected valid background.jobs')
  }
  if (
    !Array.isArray(value.background.cron) ||
    !value.background.cron.every(
      (cron) =>
        isRecord(cron) &&
        typeof cron.name === 'string' &&
        typeof cron.schedule === 'string' &&
        cron.timezone === 'UTC',
    )
  ) {
    invalid('expected valid background.cron')
  }

  return value as unknown as BlueprintManifest
}
```

Implement deterministic conversion and serialization:

```ts
const byName = <T extends { name: string }>(left: T, right: T) =>
  left.name.localeCompare(right.name)

export function blueprintFromManifest(
  manifest: BlueprintManifest,
  entry: string = BUNDERSTACK_ENTRY,
): BunderstackBlueprint {
  const environment = [...manifest.env.server, ...manifest.env.client]
    .map(({ key, required }) => ({ key, required }))
    .sort((left, right) => left.key.localeCompare(right.key))

  return {
    version: 1,
    bunderstack: { entry },
    resources: {
      database: { dialect: manifest.dialect },
      storage: {
        buckets: manifest.buckets
          .map(({ name, visibility }) => ({ name, visibility }))
          .sort(byName),
      },
      ...(manifest.realtime ? { realtime: { required: true as const } } : {}),
    },
    environment,
    background: {
      worker: { required: manifest.background.jobs.length > 0 },
      jobs: manifest.background.jobs.map(({ name }) => ({ name })).sort(byName),
      cron: manifest.background.cron
        .map(({ name, schedule, timezone }) => ({
          name,
          schedule,
          timezone,
        }))
        .sort(byName),
    },
  }
}

export function serializeBlueprint(blueprint: BunderstackBlueprint): string {
  return stringify(blueprint, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  })
}
```

- [ ] **Step 5: Run model tests to verify GREEN**

Run:

```sh
bun test scripts/blueprint/model.test.ts
```

Expected: all model, omission, sorting, parser, and serializer tests pass.

- [ ] **Step 6: Verify dependency boundaries and formatting**

Run:

```sh
bun test scripts/dependency-boundaries.test.ts
bunx oxfmt scripts/blueprint/model.ts scripts/blueprint/model.test.ts package.json
git diff --check
```

Expected: boundary tests pass; formatting only changes Task 2 files.

- [ ] **Step 7: Commit**

```sh
git add package.json bun.lock scripts/blueprint/model.ts scripts/blueprint/model.test.ts
git commit -m "feat: define static blueprint model"
```

---

### Task 3: Generate and Atomically Replace the Blueprint

**Files:**

- Create: `scripts/blueprint/generator.ts`
- Create: `scripts/blueprint/generator.test.ts`

**Interfaces:**

- Consumes:

```ts
parseBunderstackManifest(value: unknown): BlueprintManifest
blueprintFromManifest(manifest, entry): BunderstackBlueprint
serializeBlueprint(blueprint): string
```

- Produces:

```ts
export type PreparedBlueprint = {
  applicationDirectory: string
  destination: string
  blueprint: BunderstackBlueprint
  yaml: string
}

export async function loadManifestFromEntry(
  entryPath: string,
  applicationDirectory: string,
): Promise<BlueprintManifest>

export async function prepareBlueprint(
  applicationDirectory?: string,
): Promise<PreparedBlueprint>

export async function generateBlueprint(
  applicationDirectory?: string,
): Promise<PreparedBlueprint>
```

- [ ] **Step 1: Write generator test helpers and the successful generation test**

Create `scripts/blueprint/generator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'

import type { BunderstackManifest } from '../../packages/bunderstack/src/manifest'

import { generateBlueprint, prepareBlueprint } from './generator'

const manifest: BunderstackManifest = {
  version: 2,
  dialect: 'sqlite',
  tables: ['secret_table'],
  tableMap: { secret_table: 'secret_table' },
  systemTables: {
    jobs: '_bunderstack_jobs',
    files: 'bunderstack_file_meta',
    scheduledRuns: '_bunderstack_cron_runs',
  },
  defaultBucket: 'default',
  buckets: [{ name: 'default', visibility: 'private' }],
  realtime: false,
  realtimeTransport: 'disabled',
  env: { server: [{ key: 'API_KEY', required: true }], client: [] },
  background: { jobs: [], cron: [], maintenance: [] },
}

let directory: string

async function writePackageJson(
  scripts: Record<string, string> = {
    build: 'bun build src/index.ts',
    start: 'bun dist/index.js',
  },
) {
  await Bun.write(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts }, null, 2)}\n`,
  )
}

async function writeEntry(value: unknown = manifest) {
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `export const app = { manifest: ${JSON.stringify(value)} }\n`,
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bunderstack-blueprint-'))
  await mkdir(join(directory, 'src'), { recursive: true })
  await writePackageJson()
  await writeEntry()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

test.serial(
  'generates YAML beside package.json and cleans its temporary file',
  async () => {
    const result = await generateBlueprint(directory)

    expect(result.destination).toBe(
      join(directory, 'bunderstack.blueprint.yaml'),
    )
    expect(parse(await Bun.file(result.destination).text())).toEqual(
      result.blueprint,
    )
    expect((await readdir(directory)).sort()).toEqual([
      'bunderstack.blueprint.yaml',
      'package.json',
      'src',
    ])
  },
)
```

- [ ] **Step 2: Add explicit failure and preservation tests**

Add tests with exact assertions:

```ts
test.serial('fails when package scripts are missing', async () => {
  await writePackageJson({ build: 'bun build src/index.ts' })
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /package script "start"/,
  )
})

test.serial('fails when the entry does not export app', async () => {
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    'export const notApp = true\n',
  )
  await expect(prepareBlueprint(directory)).rejects.toThrow(/export app/)
})

test.serial('fails when app.manifest is unsupported', async () => {
  await writeEntry({ version: 1 })
  await expect(prepareBlueprint(directory)).rejects.toThrow(/version 2/)
})

test.serial('requires a worker script when queue jobs exist', async () => {
  await writeEntry({
    ...manifest,
    background: {
      jobs: [{ name: 'sendEmail' }],
      cron: [],
      maintenance: [],
    },
  })
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /package script "worker"/,
  )
})

test.serial(
  'preserves an existing blueprint after failed generation',
  async () => {
    const destination = join(directory, 'bunderstack.blueprint.yaml')
    await Bun.write(destination, 'existing: blueprint\n')
    await writeEntry({ version: 1 })

    await expect(generateBlueprint(directory)).rejects.toThrow(/version 2/)
    expect(await Bun.file(destination).text()).toBe('existing: blueprint\n')
  },
)

test.serial(
  'reports an atomic replacement failure and cleans the temp file',
  async () => {
    const destination = join(directory, 'bunderstack.blueprint.yaml')
    await mkdir(destination)

    await expect(generateBlueprint(directory)).rejects.toThrow(
      /failed to write blueprint/,
    )
    expect((await stat(destination)).isDirectory()).toBe(true)
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
  },
)

test.serial(
  'restores cwd and introspection env after an import failure',
  async () => {
    const previousCwd = process.cwd()
    const previousIntrospection = process.env.BUNDERSTACK_INTROSPECT
    await Bun.write(
      join(directory, 'src/bunderstack.ts'),
      'throw new Error("fixture import failed")\n',
    )

    await expect(prepareBlueprint(directory)).rejects.toThrow(
      /fixture import failed/,
    )
    expect(process.cwd()).toBe(previousCwd)
    expect(process.env.BUNDERSTACK_INTROSPECT).toBe(previousIntrospection)
  },
)
```

Add the remaining path and package failures explicitly:

```ts
test.serial('rejects a missing application directory', async () => {
  await expect(prepareBlueprint(join(directory, 'missing'))).rejects.toThrow(
    /application directory does not exist/,
  )
})

test.serial('rejects a missing package.json', async () => {
  await rm(join(directory, 'package.json'))
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /missing package\.json/,
  )
})

test.serial('rejects invalid package.json', async () => {
  await Bun.write(join(directory, 'package.json'), '{invalid')
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /invalid package\.json/,
  )
})

test.serial('rejects a missing build script', async () => {
  await writePackageJson({ start: 'bun dist/index.js' })
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /package script "build"/,
  )
})

test.serial('rejects a missing Bunderstack entry', async () => {
  await rm(join(directory, 'src/bunderstack.ts'))
  await expect(prepareBlueprint(directory)).rejects.toThrow(
    /missing Bunderstack entry/,
  )
})
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```sh
bun test scripts/blueprint/generator.test.ts
```

Expected: FAIL because `scripts/blueprint/generator.ts` does not exist.

- [ ] **Step 4: Implement package and entry validation**

Create `scripts/blueprint/generator.ts` with constants and helpers:

```ts
import { randomUUID } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BUNDERSTACK_ENTRY,
  type BunderstackBlueprint,
  type BlueprintManifest,
  blueprintFromManifest,
  parseBunderstackManifest,
  serializeBlueprint,
} from './model'

const BLUEPRINT_FILE = 'bunderstack.blueprint.yaml'

type PackageJson = {
  scripts?: Record<string, unknown>
}

async function applicationRoot(input: string): Promise<string> {
  const directory = resolve(input)
  const info = await stat(directory).catch(() => null)
  if (!info?.isDirectory()) {
    throw new Error(
      `[bunderstack blueprint] application directory does not exist: ${directory}`,
    )
  }
  return directory
}

async function readPackageJson(directory: string): Promise<PackageJson> {
  const path = join(directory, 'package.json')
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`[bunderstack blueprint] missing package.json: ${path}`)
  }
  try {
    return (await file.json()) as PackageJson
  } catch (cause) {
    throw new Error(`[bunderstack blueprint] invalid package.json: ${path}`, {
      cause,
    })
  }
}

function requirePackageScript(packageJson: PackageJson, name: string): void {
  const value = packageJson.scripts?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[bunderstack blueprint] package.json requires package script "${name}"`,
    )
  }
}
```

- [ ] **Step 5: Implement scoped application loading and cleanup**

Add:

```ts
type AppModule = {
  app?: {
    manifest?: unknown
    close?: () => void | Promise<void>
  }
}

export async function loadManifestFromEntry(
  entryPath: string,
  applicationDirectory: string,
): Promise<BlueprintManifest> {
  const previousCwd = process.cwd()
  const previousIntrospection = process.env.BUNDERSTACK_INTROSPECT
  let app: AppModule['app']

  process.chdir(applicationDirectory)
  process.env.BUNDERSTACK_INTROSPECT = '1'

  try {
    const url = pathToFileURL(entryPath)
    url.searchParams.set('blueprint', randomUUID())
    const module = (await import(url.href)) as AppModule
    app = module.app
    if (!app) {
      throw new Error(
        `[bunderstack blueprint] ${BUNDERSTACK_ENTRY} must export app`,
      )
    }
    return parseBunderstackManifest(app.manifest)
  } finally {
    try {
      await app?.close?.()
    } finally {
      process.chdir(previousCwd)
      if (previousIntrospection === undefined) {
        delete process.env.BUNDERSTACK_INTROSPECT
      } else {
        process.env.BUNDERSTACK_INTROSPECT = previousIntrospection
      }
    }
  }
}
```

Keep the import tests serial because `process.chdir()` and `process.env` are
process-global. Do not inherit or synthesize application env values.

- [ ] **Step 6: Implement preparation and atomic replacement**

Add:

```ts
export type PreparedBlueprint = {
  applicationDirectory: string
  destination: string
  blueprint: BunderstackBlueprint
  yaml: string
}

export async function prepareBlueprint(
  input: string = process.cwd(),
): Promise<PreparedBlueprint> {
  const applicationDirectory = await applicationRoot(input)
  const packageJson = await readPackageJson(applicationDirectory)
  requirePackageScript(packageJson, 'build')
  requirePackageScript(packageJson, 'start')

  const entryPath = join(applicationDirectory, BUNDERSTACK_ENTRY)
  if (!(await Bun.file(entryPath).exists())) {
    throw new Error(
      `[bunderstack blueprint] missing Bunderstack entry: ${entryPath}`,
    )
  }

  const manifest = await loadManifestFromEntry(entryPath, applicationDirectory)
  if (manifest.background.jobs.length > 0) {
    requirePackageScript(packageJson, 'worker')
  }

  const blueprint = blueprintFromManifest(manifest)
  return {
    applicationDirectory,
    destination: join(applicationDirectory, BLUEPRINT_FILE),
    blueprint,
    yaml: serializeBlueprint(blueprint),
  }
}

async function replaceAtomically(
  destination: string,
  contents: string,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${BLUEPRINT_FILE}.${randomUUID()}.tmp`,
  )
  try {
    await Bun.write(temporary, contents)
    await rename(temporary, destination)
  } catch (cause) {
    throw new Error(
      `[bunderstack blueprint] failed to write blueprint: ${destination}`,
      { cause },
    )
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function generateBlueprint(
  input: string = process.cwd(),
): Promise<PreparedBlueprint> {
  const prepared = await prepareBlueprint(input)
  await replaceAtomically(prepared.destination, prepared.yaml)
  return prepared
}
```

- [ ] **Step 7: Run focused tests to verify GREEN**

Run:

```sh
bun test scripts/blueprint/model.test.ts scripts/blueprint/generator.test.ts
```

Expected: all tests pass; no temp files remain.

- [ ] **Step 8: Run package regression tests**

Run:

```sh
bun test --cwd packages/bunderstack
bun run typecheck
git diff --check
```

Expected: all Bunderstack tests and package typechecks pass.

- [ ] **Step 9: Commit**

```sh
git add scripts/blueprint/generator.ts scripts/blueprint/generator.test.ts
git commit -m "feat: generate committed blueprint yaml"
```

---

### Task 4: Add the Internal Script and Dogfood the Todo Blueprint

**Files:**

- Create: `scripts/generate-blueprint.ts`
- Create: `scripts/generate-blueprint.test.ts`
- Modify: `examples/todo/package.json`
- Create: `examples/todo/bunderstack.blueprint.yaml`

**Interfaces:**

- Consumes:

```ts
prepareBlueprint(applicationDirectory): Promise<PreparedBlueprint>
generateBlueprint(applicationDirectory): Promise<PreparedBlueprint>
```

- Produces:

```ts
export async function main(args?: string[]): Promise<void>
```

and the internal invocation:

```sh
bun scripts/generate-blueprint.ts [application-directory]
```

- [ ] **Step 1: Write failing CLI tests**

Create `scripts/generate-blueprint.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { prepareBlueprint } from './blueprint/generator'

const repositoryRoot = resolve(import.meta.dir, '..')

test('internal script generates a blueprint for a valid fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blueprint-cli-'))
  await mkdir(join(directory, 'src'), { recursive: true })
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { build: 'bun build app.ts', start: 'bun app.js' },
    }),
  )
  await Bun.write(
    join(directory, 'src/bunderstack.ts'),
    `export const app = {
      manifest: {
        version: 2,
        dialect: 'sqlite',
        buckets: [{ name: 'default', visibility: 'private' }],
        realtime: false,
        env: { server: [], client: [] },
        background: { jobs: [], cron: [] }
      }
    }\n`,
  )

  try {
    const process = Bun.spawn(
      [
        Bun.which('bun')!,
        join(repositoryRoot, 'scripts/generate-blueprint.ts'),
        directory,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await process.exited).toBe(0)
    expect(
      await Bun.file(join(directory, 'bunderstack.blueprint.yaml')).exists(),
    ).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.serial(
  'committed todo blueprint matches current app declaration',
  async () => {
    const directory = join(repositoryRoot, 'examples/todo')
    const prepared = await prepareBlueprint(directory)
    const committed = await Bun.file(prepared.destination).text()
    expect(committed).toBe(prepared.yaml)
  },
)
```

The first test intentionally proves the executable boundary, not only imported
functions. The second is the prototype's freshness guard without publishing a
`--check` mode.

- [ ] **Step 2: Run the CLI test to verify RED**

Run:

```sh
bun test scripts/generate-blueprint.test.ts
```

Expected: FAIL because `scripts/generate-blueprint.ts` and the committed todo
blueprint do not exist.

- [ ] **Step 3: Implement the thin executable wrapper**

Create `scripts/generate-blueprint.ts`:

```ts
import { generateBlueprint } from './blueprint/generator'

export async function main(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.length > 1) {
    throw new Error(
      'Usage: bun scripts/generate-blueprint.ts [application-directory]',
    )
  }
  const result = await generateBlueprint(args[0] ?? process.cwd())
  console.log(`Generated ${result.destination}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
```

- [ ] **Step 4: Add the todo production start convention**

In `examples/todo/package.json`, keep the existing scripts and add:

```json
{
  "scripts": {
    "dev": "bun --bun vite dev --port 3005",
    "worker": "bun src/worker.ts",
    "build": "vite build",
    "start": "bun .output/server/index.mjs"
  }
}
```

Do not add a generator package script.

- [ ] **Step 5: Generate the dogfood artifact**

Run:

```sh
bun scripts/generate-blueprint.ts examples/todo
```

Expected: creates `examples/todo/bunderstack.blueprint.yaml` with this semantic
shape and no table or maintenance entries:

```yaml
version: 1
bunderstack:
  entry: src/bunderstack.ts
resources:
  database:
    dialect: sqlite
  storage:
    buckets:
      - name: images
        visibility: private
  realtime:
    required: true
environment:
  - key: NOTIFY_COMPLETED
    required: false
  - key: PUBLIC_APP_NAME
    required: false
background:
  worker:
    required: true
  jobs:
    - name: celebrateBoardComplete
  cron:
    - name: archiveDoneTodos
      schedule: '* * * * *'
      timezone: UTC
```

Accept the `yaml` package's canonical safe quote style if it uses single
instead of double quotes; the parsed value must match exactly.

- [ ] **Step 6: Run focused CLI and freshness tests**

Run:

```sh
bun test scripts/generate-blueprint.test.ts
```

Expected: executable fixture generation passes and the committed todo file
equals freshly prepared YAML byte-for-byte.

- [ ] **Step 7: Run complete verification**

Run:

```sh
bun test scripts/
bun test --cwd packages/bunderstack
bun run typecheck:all
bun scripts/generate-blueprint.ts examples/todo
bun test scripts/generate-blueprint.test.ts
git diff --check
```

Expected:

- all script and Bunderstack tests pass;
- all package and example typechecks pass;
- regenerating the todo blueprint produces no diff;
- no unrelated working-tree files are staged or modified by the implementation.

- [ ] **Step 8: Commit**

```sh
git add scripts/generate-blueprint.ts scripts/generate-blueprint.test.ts examples/todo/package.json examples/todo/bunderstack.blueprint.yaml
git commit -m "feat: add internal blueprint generator"
```

---

## Final Review Checklist

- [ ] `provision()` exits before reading app internals when introspecting.
- [ ] Generator imports with `BUNDERSTACK_INTROSPECT=1` and restores both env and cwd.
- [ ] Imported app lifecycle is closed.
- [ ] Existing blueprint survives every validation/import/serialization failure.
- [ ] Successful writes use a same-directory temporary file and atomic rename.
- [ ] YAML includes only the agreed v1 fields.
- [ ] YAML collections are deterministically sorted.
- [ ] Disabled realtime is omitted; empty env/jobs/cron arrays are explicit.
- [ ] Queue jobs require the `worker` package convention.
- [ ] Todo dogfood output is current and contains no tables, credentials, values, commands, providers, or maintenance work.
- [ ] No Bunderhost code is changed in this plan.
