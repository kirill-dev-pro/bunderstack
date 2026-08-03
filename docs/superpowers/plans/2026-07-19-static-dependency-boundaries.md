# Static Dependency Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every production dependency reachable through a statically analyzable module graph, keep optional integrations behind explicit subpath entrypoints, and give application owners control of host-library versions through peer dependencies.

**Architecture:** Database engines and SMTP become explicit adapters imported from dedicated subpaths; the root packages no longer discover optional packages through computed `import()`. Browser packages split their REST, schema-aware, tRPC, and auth surfaces so importing a lightweight client cannot pull server code or unrelated integrations. Literal `import()` remains allowed only when Vite can analyze it; `@vite-ignore`, `webpackIgnore`, and computed module specifiers are prohibited in published source.

**Tech Stack:** Bun, TypeScript source packages, Drizzle ORM, Better Auth, Hono, tRPC, TanStack Query/DB/Start, Vite.

## Global Constraints

- Use Bun for installs, scripts, builds, and tests.
- Continue publishing TypeScript source; do not add a JavaScript compilation/publishing pipeline.
- Keep `typescript` as an optional peer with range `>=5` in every published package, and as a dev dependency where package tests/typechecks need it.
- Keep the existing single Web-Standard `Request -> Response` handler and raw `app.db`, `app.auth`, and `app.router` escape hatches.
- Do not add service-locator state, adapter registration side effects, or global registries.
- No published source file may contain `@vite-ignore`, `webpackIgnore`, or `import(<computed expression>)`.
- Literal dynamic imports are permitted only for analyzable code splitting and must have a dependency-boundary test.
- A package root entrypoint must not re-export an optional integration subpath.
- Preserve existing REST, storage, jobs, realtime, and auth behavior except for the explicitly documented adapter/import migrations.
- This is a breaking pre-1.0 release; update all workspace examples and READMEs in the same change.

---

## Target public API

### Database selection

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

const app = await createBunderstack({
  schema,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
})
```

The other adapters are:

```ts
import { pglite } from 'bunderstack/database/pglite'
import { bunSql } from 'bunderstack/database/bun-sql'
import { postgresJs } from 'bunderstack/database/postgres-js'
```

`database.adapter` is required. Bunderstack must not infer an engine from a URL and then discover its package at runtime. It still validates that the adapter dialect matches the schema dialect and that obviously incompatible URLs fail with the current actionable messages.

Deployment introspection must select an in-memory-capable adapter explicitly. A server-Postgres application that uses Bun SQL normally and PGlite for introspection should keep both imports static and select between already-imported adapter values:

```ts
const adapter = process.env.BUNDERSTACK_INTROSPECT === '1' ? pglite() : bunSql()
```

Core may continue replacing the URL with `:memory:` in introspection mode, but it must never silently replace the selected adapter. Document that `libsql()` and `pglite()` support `:memory:`; `bunSql()` and `postgresJs()` do not.

### SMTP

```ts
import { smtp } from 'bunderstack/email/smtp'

const app = await createBunderstack({
  schema,
  database: { adapter: libsql() },
  email: {
    from: 'app@example.com',
    provider: smtp({ url: process.env.SMTP_URL! }),
  },
})
```

`'resend'`, `'console'`, custom adapter objects, and custom send functions remain supported by the root package. The string provider `'smtp'` is removed because it requires hidden module discovery.

### Query entrypoints

```ts
// Lightweight inferred REST/files client. No tRPC and no server package.
import { createClient } from 'bunderstack-query'

// Explicit tRPC integration.
import { createTRPCClient } from 'bunderstack-query/trpc'

// Explicit runtime-schema integration; intentionally allowed to load Drizzle.
import { createBunderstackSchemaClient } from 'bunderstack-query/schema'
```

### Start auth

```ts
import { createStartAuthClient } from 'bunderstack-start/auth'
```

The `bunderstack-start` root no longer re-exports Better Auth client code.

---

### Task 1: Add dependency-boundary regression tests

**Files:**

- Create: `scripts/dependency-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: published source under `packages/*/src` and the four package manifests.
- Produces: a fast repository-level test that fails on non-analyzable imports, forbidden root imports, and manifest drift.

- [ ] **Step 1: Write the source-graph tests**

Create `scripts/dependency-boundaries.test.ts` with these assertions:

```ts
import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const packages = [
  'bunderstack',
  'bunderstack-query',
  'bunderstack-sync',
  'bunderstack-start',
] as const

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) return []
      if (/\.test\.(ts|tsx)$/.test(entry.name)) return []
      return [path]
    }),
  )
  return nested.flat()
}

describe('published dependency boundaries', () => {
  test('published source has no bundler-ignore escape hatches', async () => {
    for (const name of packages) {
      for (const path of await sourceFiles(
        join(root, 'packages', name, 'src'),
      )) {
        const source = await Bun.file(path).text()
        expect(source, path).not.toContain('@vite-ignore')
        expect(source, path).not.toContain('webpackIgnore')
      }
    }
  })

  test('dynamic imports use string literals', async () => {
    for (const name of packages) {
      for (const path of await sourceFiles(
        join(root, 'packages', name, 'src'),
      )) {
        const source = await Bun.file(path).text()
        const imports = source.matchAll(/\bimport\s*\(([^)]*)\)/gs)
        for (const match of imports) {
          const argument = match[1]!.trim()
          expect(argument, `${path}: import(${argument})`).toMatch(
            /^(?:'[^']+'|"[^"]+")$/s,
          )
        }
      }
    }
  })

  test('lightweight client roots do not import optional integrations', async () => {
    const query = await Bun.file(
      join(root, 'packages/bunderstack-query/src/index.ts'),
    ).text()
    expect(query).not.toMatch(
      /from ['"](?:bunderstack(?:\/|['"])|@trpc\/|superjson)/,
    )

    const start = await Bun.file(
      join(root, 'packages/bunderstack-start/src/index.ts'),
    ).text()
    expect(start).not.toMatch(/from ['"]better-auth/)
    expect(start).not.toContain('export { createStartAuthClient }')
  })
})
```

- [ ] **Step 2: Run the tests and confirm the intended failures**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts
```

Expected: failures identify `@vite-ignore`/`webpackIgnore` in `db.ts`, `email.ts`, `provision.ts`, and `isomorphic-fetch.ts`; the lightweight query/start assertions also fail.

- [ ] **Step 3: Include the new test in the root test command**

The current root command already runs `bun test scripts/`; retain that behavior. Do not add a second invocation. Add a separate convenience script:

```json
"test:boundaries": "bun test scripts/dependency-boundaries.test.ts"
```

- [ ] **Step 4: Commit the red test checkpoint**

```bash
git add package.json scripts/dependency-boundaries.test.ts
git commit -m "test: define static dependency boundaries"
```

---

### Task 2: Replace database module discovery with explicit adapters

**Files:**

- Create: `packages/bunderstack/src/database/adapter.ts`
- Create: `packages/bunderstack/src/database/libsql.ts`
- Create: `packages/bunderstack/src/database/pglite.ts`
- Create: `packages/bunderstack/src/database/bun-sql.ts`
- Create: `packages/bunderstack/src/database/postgres-js.ts`
- Create: `packages/bunderstack/src/database/adapter.test.ts`
- Modify: `packages/bunderstack/src/db.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/provision-internals.ts`
- Modify: `packages/bunderstack/src/provision.ts`
- Modify: `packages/bunderstack/package.json`

**Interfaces:**

- Consumes: schema dialect detection, the resolved database URL/auth token, and Drizzle driver/migrator functions.
- Produces: `DatabaseAdapter`, `DatabaseConnection`, and four statically imported adapter factories.

- [ ] **Step 1: Write adapter contract tests**

Create tests which use fake adapters so the core behavior does not require every database engine:

```ts
import { describe, expect, test } from 'bun:test'
import type { DatabaseAdapter } from './adapter'

describe('DatabaseAdapter', () => {
  test('is structural and carries an explicit dialect and driver', async () => {
    const adapter: DatabaseAdapter = {
      dialect: 'sqlite',
      driver: 'libsql',
      connect: async (_schema, connection) => ({ connection }) as never,
      migrate: async () => {},
    }

    expect(adapter.dialect).toBe('sqlite')
    expect(adapter.driver).toBe('libsql')
    expect(await adapter.connect({}, { url: 'file:test.db' })).toEqual({
      connection: { url: 'file:test.db' },
    })
  })
})
```

Extend `packages/bunderstack/src/config.test.ts` and `packages/bunderstack/src/db.test.ts` with these cases:

- missing `database.adapter` rejects with `[bunderstack] database.adapter is required`;
- a sqlite schema with a `dialect: 'pg'` adapter rejects before `connect`;
- a pg schema with a `dialect: 'sqlite'` adapter rejects before `connect`;
- `connect` receives the resolved URL and auth token exactly once.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
bun test --cwd packages/bunderstack src/database/adapter.test.ts src/config.test.ts src/db.test.ts
```

Expected: FAIL because the adapter files and required configuration do not exist.

- [ ] **Step 3: Define the adapter contract**

Create `packages/bunderstack/src/database/adapter.ts`:

```ts
import type { AnyDb, Dialect } from '../dialect'
import type { DbFor, Driver } from '../db'

export type DatabaseConnection = {
  url: string
  authToken?: string
}

export type DatabaseAdapter = {
  readonly dialect: Dialect
  readonly driver: Driver
  connect<TSchema extends Record<string, unknown>>(
    schema: TSchema,
    connection: DatabaseConnection,
  ): Promise<DbFor<TSchema>>
  migrate(db: AnyDb, migrationsFolder: string): Promise<void>
}
```

Retain only `Driver`, `DbFor`, URL validation helpers, and a new adapter-driven `createDb` in `db.ts`. Delete `importDriver` and every runtime import from that file. The new function is:

```ts
export async function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: DatabaseConnection & { adapter: DatabaseAdapter; dialect: Dialect },
): Promise<{ db: DbFor<TSchema>; driver: Driver }> {
  if (cfg.adapter.dialect !== cfg.dialect) {
    throw new Error(
      `[bunderstack] database adapter dialect ${cfg.adapter.dialect} does not match ${cfg.dialect} schema`,
    )
  }
  validateDatabaseUrl(cfg.url, cfg.dialect)
  const db = await cfg.adapter.connect(schema, {
    url: cfg.url,
    authToken: cfg.authToken,
  })
  return { db, driver: cfg.adapter.driver }
}
```

- [ ] **Step 4: Implement the four static adapters**

Each file must use top-level static imports for both `drizzle` and `migrate`. For example, `database/libsql.ts`:

```ts
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import type { DatabaseAdapter } from './adapter'

export function libsql(): DatabaseAdapter {
  return {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect(schema, connection) {
      return drizzle({ connection, schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
```

Implement the remaining adapters with the following connection bodies and the matching static migrator import in each file:

```ts
// database/pglite.ts
import { mkdir } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

const rawPath = (url: string) =>
  url.startsWith('file:') ? url.slice('file:'.length) : url

export function pglite(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'pglite',
    async connect(schema, { url }) {
      const raw = rawPath(url)
      const dataDir = raw === ':memory:' ? 'memory://' : raw
      if (!dataDir.startsWith('memory://'))
        await mkdir(dataDir, { recursive: true })
      return drizzle(dataDir, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}

// database/bun-sql.ts
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

export function bunSql(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'bun-sql',
    async connect(schema, { url }) {
      return drizzle(url, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}

// database/postgres-js.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

export function postgresJs(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'postgres-js',
    async connect(schema, { url }) {
      return drizzle(url, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
```

Import `DatabaseAdapter` from `./adapter` in all three files. Add adapter-specific URL tests: PGlite rejects `postgres://`; Bun SQL and postgres.js reject non-Postgres URLs; libSQL rejects Postgres URLs. The Bun SQL adapter must not import an external Postgres client.

- [ ] **Step 5: Require the adapter in resolved configuration**

Change the database portion of `BunderstackConfig`/`ResolvedConfig` to:

```ts
database?: {
  adapter: DatabaseAdapter
  url?: string
  authToken?: string
  migrations?: string
}
```

Resolve the default URL from `adapter.dialect`, not from a second independently chosen driver. Keep `file:./data.db` for sqlite and `file:./data.pglite` for pg. Reject an absent adapter with the exact message tested in Step 1.

- [ ] **Step 6: Store the adapter for provisioning**

Replace the hidden `driver` field in `WithProvisionInternals` with:

```ts
adapter: DatabaseAdapter
```

In `provision.ts`, remove `MIGRATOR_MODULES` and call:

```ts
await adapter.migrate(db, migrationsFolder)
```

Keep the literal `import('drizzle-kit/api')` for development schema push, but remove both ignore comments. It is statically analyzable and isolated behind the existing `bunderstack/provision` subpath.

- [ ] **Step 7: Export the adapter subpaths**

Add:

```json
"./database/libsql": "./src/database/libsql.ts",
"./database/pglite": "./src/database/pglite.ts",
"./database/bun-sql": "./src/database/bun-sql.ts",
"./database/postgres-js": "./src/database/postgres-js.ts"
```

Do not export adapters from `bunderstack` root.

- [ ] **Step 8: Run database and provisioning tests**

```bash
bun test --cwd packages/bunderstack src/db.test.ts src/db.pg.test.ts src/bunsql.integration.test.ts src/provision.test.ts src/provision.integration.test.ts src/provision.pg.integration.test.ts src/database/adapter.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
bun test scripts/dependency-boundaries.test.ts
```

Expected: all selected tests and typecheck pass; remaining boundary failures only reference SMTP, Start, or query entrypoints.

- [ ] **Step 9: Commit the database adapter boundary**

```bash
git add packages/bunderstack/src packages/bunderstack/package.json scripts/dependency-boundaries.test.ts
git commit -m "refactor: make database drivers explicit adapters"
```

---

### Task 3: Move SMTP to an explicit integration subpath

**Files:**

- Create: `packages/bunderstack/src/email/smtp.ts`
- Create: `packages/bunderstack/src/email/smtp.test.ts`
- Modify: `packages/bunderstack/src/email.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/package.json`

**Interfaces:**

- Consumes: `nodemailer.createTransport` and the existing `EmailAdapter` contract.
- Produces: `smtp({ url }): EmailAdapter` from `bunderstack/email/smtp`.

- [ ] **Step 1: Write the SMTP adapter test**

Use a constructor seam so the unit test does not send mail:

```ts
import { expect, test } from 'bun:test'
import { createSmtpAdapter } from './smtp'

test('smtp adapter maps EmailMessage to nodemailer', async () => {
  const calls: unknown[] = []
  const adapter = createSmtpAdapter({ url: 'smtp://localhost' }, () => ({
    async sendMail(message) {
      calls.push(message)
      return { messageId: 'mail-1' }
    },
  }))

  await expect(
    adapter.send({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 'S',
      text: 'T',
    }),
  ).resolves.toEqual({ id: 'mail-1' })
  expect(calls).toHaveLength(1)
})
```

- [ ] **Step 2: Verify failure**

```bash
bun test --cwd packages/bunderstack src/email/smtp.test.ts
```

Expected: FAIL because the SMTP subpath does not exist.

- [ ] **Step 3: Implement the SMTP adapter with a static import**

`packages/bunderstack/src/email/smtp.ts` must begin with:

```ts
import nodemailer from 'nodemailer'
import type { EmailAdapter, EmailMessage } from '../email'
```

Export both:

```ts
type TransportFactory = (url: string) => {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>
}

export function createSmtpAdapter(
  options: { url: string },
  createTransport: TransportFactory = (url) => nodemailer.createTransport(url),
): EmailAdapter

export const smtp = (options: { url: string }): EmailAdapter =>
  createSmtpAdapter(options)
```

Move the existing message mapping into this file. Delete `canResolveModule`, `Bun.resolveSync`, the dynamic import, and the `'smtp'` string branch from `email.ts`. Keep custom adapter support, so `provider: smtp(...)` works without special casing.

Add `@types/nodemailer` compatible with nodemailer 6 to `devDependencies` so the package source typechecks without weakening `noImplicitAny`.

- [ ] **Step 4: Add the package export and update tests**

Add:

```json
"./email/smtp": "./src/email/smtp.ts"
```

Update existing email tests to assert that the string `'smtp'` is rejected by config typing/validation and that custom adapter objects still work.

- [ ] **Step 5: Verify email and boundary tests**

```bash
bun test --cwd packages/bunderstack src/email.test.ts src/auth-email.test.ts src/email/smtp.test.ts
bun test scripts/dependency-boundaries.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: email tests pass; no dynamic-import boundary failure remains in `email.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/email.ts packages/bunderstack/src/email packages/bunderstack/src/config.ts packages/bunderstack/package.json
git commit -m "refactor: expose smtp as a static adapter"
```

---

### Task 4: Split lightweight, schema, and tRPC query entrypoints

**Files:**

- Create: `packages/bunderstack-query/src/client.ts`
- Create: `packages/bunderstack-query/src/schema.ts`
- Create: `packages/bunderstack-query/src/trpc.ts`
- Create: `packages/bunderstack-query/src/entrypoints.test.ts`
- Modify: `packages/bunderstack-query/src/index.ts`
- Modify: `packages/bunderstack-query/src/infer.ts`
- Modify: `packages/bunderstack-query/src/types.ts`
- Delete: `packages/bunderstack-query/src/lazy-client.ts`
- Modify: `packages/bunderstack-query/src/react.tsx`
- Modify: `packages/bunderstack-query/package.json`
- Modify: query package tests that import `createClient`

**Interfaces:**

- Consumes: existing table, bucket, mutation, realtime, inference, and tRPC client primitives.
- Produces: a REST-only root `createClient`, explicit `createTRPCClient`, and explicit runtime-schema builder.

- [ ] **Step 1: Add entrypoint behavior tests**

Write tests that prove:

```ts
import { createClient } from './index'
import { createTRPCClient } from './trpc'
import { createBunderstackSchemaClient } from './schema'
```

- root `createClient<App>()` lazily exposes tables and files but has no runtime `trpc` property;
- `createTRPCClient<App>()` exposes the same tables/files plus a lazily cached `trpc` proxy;
- the schema builder retains current `withSchema` behavior;
- the ordinary builder retains `withTables`, `withFiles`, and `with`, but no longer exposes `withSchema`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test --cwd packages/bunderstack-query src/entrypoints.test.ts tests/client.test.ts tests/lazy-client.test.ts
```

Expected: FAIL because the entrypoints have not been split.

- [ ] **Step 3: Build the REST-only inferred client**

Move `ClientOptions`, `PROXY_SKIP`, `lazyRecord`, files creation, tables creation, and the outer Proxy from `lazy-client.ts` into `client.ts`. Define:

```ts
export type RestBunderstackClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableQueryOptionsForKey<InferSchema<TApp>, K>
} & FilesQueryClient<InferBuckets<TApp>>

export function createClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): RestBunderstackClient<TApp>
```

The proxy must return `files` for that property and table clients otherwise. It must not contain a `trpc` branch or import any `@trpc/*` runtime module.

Remove the type-only server-package leaks from the lightweight graph as part of this step:

- in `types.ts`, replace the imported `TableAccessInput` constraint with a local structural `Record<string, unknown>` constraint, because only `schema.ts` needs the concrete server access type;
- in `infer.ts`, remove `AnyRouter` and infer a declared router as `Exclude<InferCarrier<TApp>['trpc'], undefined>`; the explicit tRPC entrypoint applies `@trpc/server` constraints where it consumes the type.

- [ ] **Step 4: Build the explicit tRPC client**

Move the tRPC imports and `getTrpc` implementation into `trpc.ts`. Compose the REST client rather than duplicating its table/file construction:

```ts
export type TRPCBunderstackClient<TApp extends AnyBunderstackApp> =
  RestBunderstackClient<TApp> & {
    trpc: TRPCOptionsProxy<InferTrpcRouter<TApp>>
  }

export function createTRPCClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): TRPCBunderstackClient<TApp> {
  const rest = createClient<TApp>(options)
  let trpcProxy: TRPCOptionsProxy<InferTrpcRouter<TApp>> | undefined
  return new Proxy(rest, {
    get(target, property, receiver) {
      if (property !== 'trpc') return Reflect.get(target, property, receiver)
      trpcProxy ??= createTRPCOptionsProxy({
        client: createTRPCClientTransport(options),
        queryClient: options.queryClient ?? new QueryClient(),
      })
      return trpcProxy
    },
  }) as TRPCBunderstackClient<TApp>
}
```

Name the internal transport helper `createTRPCClientTransport` to avoid colliding with the exported factory. Preserve the current `/api/trpc`, SuperJSON, fetch override, and QueryClient behavior exactly.

- [ ] **Step 5: Move runtime-schema behavior out of root**

`schema.ts` owns the only runtime import of `bunderstack/access` and exports:

```ts
export function createBunderstackSchemaClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
    withSchema<
      S extends TSchema,
      TAccess extends Record<string, TableAccessInput> | undefined = undefined,
    >(
      options: BaseOptions & { schema: S; access?: TAccess },
    ): BunderstackQueryClient<S, CrudTableKey<S>> {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
      const client = {} as BunderstackQueryClient<S, CrudTableKey<S>>
      const config = {
        baseUrl,
        fetch: fetchFn,
        queryClient: options.queryClient,
      }
      const resolved = validateAndResolveAccess(options.schema, options.access)

      for (const [tableKey, tableAccess] of resolved) {
        if (!tableAccess.enabled) continue
        ;(client as Record<string, unknown>)[tableKey] = buildTableQueryOptions(
          tableKey as keyof S & string,
          tableAccess.tableName,
          options.schema[tableKey],
          config,
        )
      }
      return client
    },
  }
}
```

Move the existing `buildTableQueryOptions` helper and `withSchema` implementation there. Root `index.ts` keeps `withTables`, `withFiles`, and `with`. Do not re-export `createBunderstackSchemaClient` from root.

- [ ] **Step 6: Define package exports**

Use:

```json
"exports": {
  ".": "./src/index.ts",
  "./schema": "./src/schema.ts",
  "./trpc": "./src/trpc.ts",
  "./react": "./src/react.tsx"
}
```

Root exports `createClient` from `client.ts`. It must not re-export anything from `schema.ts` or `trpc.ts`.

- [ ] **Step 7: Update query package tests and compatibility imports**

Move REST/files cases from `tests/lazy-client.test.ts` into the existing `tests/client.test.ts`, create `tests/trpc-client.test.ts` for every `api.trpc` case, and delete `tests/lazy-client.test.ts`. Imports must match the new public subpaths. Keep `react.tsx` deprecated aliases limited to lightweight root exports.

- [ ] **Step 8: Verify query isolation**

```bash
bun test --cwd packages/bunderstack-query
bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json
bun test scripts/dependency-boundaries.test.ts
```

Build the root and inspect its metafile:

```bash
audit_dir=$(mktemp -d /tmp/bunderstack-query-audit.XXXXXX)
bun build packages/bunderstack-query/src/index.ts --target=browser --outfile="$audit_dir/index.js" --metafile="$audit_dir/meta.json" --minify
rg 'bunderstack/src|@trpc|superjson' "$audit_dir/meta.json"
```

Expected: `rg` exits 1 with no matches and `index.js` is below the initial **32 KiB minified** budget. Task 9 codifies that exact budget; do not use the old 160 KB baseline.

- [ ] **Step 9: Commit**

```bash
git add packages/bunderstack-query scripts/dependency-boundaries.test.ts
git commit -m "refactor: isolate query integrations by entrypoint"
```

---

### Task 5: Make TanStack Start imports analyzable and isolate Better Auth

**Files:**

- Modify: `packages/bunderstack-start/src/isomorphic-fetch.ts`
- Modify: `packages/bunderstack-start/src/index.ts`
- Modify: `packages/bunderstack-start/src/index.test.ts`
- Modify: `packages/bunderstack-start/package.json`

**Interfaces:**

- Consumes: `@tanstack/react-start/server` through a literal analyzable import and Better Auth only through `./auth`.
- Produces: a Better-Auth-free root and `bunderstack-start/auth` subpath.

- [ ] **Step 1: Add isolation tests**

Extend `index.test.ts` to import `createStartAuthClient` directly from `./auth-client` and retain its behavior tests. Add a manifest assertion that `exports['./auth'] === './src/auth-client.ts'`.

- [ ] **Step 2: Remove ignore comments from the literal import**

Keep:

```ts
const mod = await import('@tanstack/react-start/server')
```

The `typeof window` guard and fallback origin behavior stay unchanged. Update the comment to say that the literal import is intentionally visible to Vite so SSR dependency tracing can include it.

- [ ] **Step 3: Remove Better Auth from the root graph**

Delete this root re-export:

```ts
export { createStartAuthClient } from './auth-client'
```

Add:

```json
"./auth": "./src/auth-client.ts"
```

- [ ] **Step 4: Verify Start package**

```bash
bun test --cwd packages/bunderstack-start
bunx tsc --noEmit -p packages/bunderstack-start/tsconfig.json
bun test scripts/dependency-boundaries.test.ts
```

Expected: all pass; no ignore comments remain anywhere under published source.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack-start scripts/dependency-boundaries.test.ts
git commit -m "refactor: isolate start auth integration"
```

---

### Task 6: Reclassify dependencies and make TypeScript an optional peer

**Files:**

- Modify: `packages/bunderstack/package.json`
- Modify: `packages/bunderstack-query/package.json`
- Modify: `packages/bunderstack-sync/package.json`
- Modify: `packages/bunderstack-start/package.json`
- Modify: `scripts/dependency-boundaries.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: the entrypoint boundaries produced by Tasks 2–5.
- Produces: manifests where host libraries are peers, optional integrations are optional peers, and internal implementation libraries remain dependencies.

- [ ] **Step 1: Add exact manifest assertions**

Extend `dependency-boundaries.test.ts` to load each `package.json` and assert:

```ts
for (const manifest of manifests) {
  expect(manifest.peerDependencies?.typescript).toBe('>=5')
  expect(manifest.peerDependenciesMeta?.typescript?.optional).toBe(true)
}
```

Also assert these package-specific rules:

- `bunderstack` required peers: `@trpc/server`, `better-auth`, `drizzle-orm`, `hono`, `zod`;
- `bunderstack` optional peers: `@electric-sql/pglite`, `@libsql/client`, `drizzle-kit`, `nodemailer`, `postgres`, `typescript`;
- `bunderstack` dependency: `superjson` only;
- `bunderstack-query` required peer: `@tanstack/react-query`;
- `bunderstack-query` optional peers: `@trpc/client`, `@trpc/server`, `@trpc/tanstack-react-query`, `bunderstack`, `superjson`, `typescript`;
- `bunderstack-query` has no regular dependencies;
- `bunderstack-sync` dependencies: `bunderstack-query` only; there is no direct `bunderstack` dependency;
- `bunderstack-start` dependencies: `bunderstack-sync` only; there is no direct `bunderstack-query` dependency;
- existing TanStack DB/Query peers remain required in sync/start;
- Better Auth remains an optional peer of `bunderstack-start` because only `./auth` needs it.

- [ ] **Step 2: Verify manifest tests fail before editing manifests**

```bash
bun test scripts/dependency-boundaries.test.ts
```

Expected: manifest assertions fail.

- [ ] **Step 3: Rewrite the four manifests**

Move host libraries to both `peerDependencies` and `devDependencies`. Optional peer metadata must include TypeScript:

```json
"typescript": {
  "optional": true
}
```

Use `">=5"`, not `"*"`: the codebase relies on modern TypeScript syntax and `moduleResolution: "bundler"`, while the open upper bound avoids conflicts with TypeScript 6 and 7.

Do not mark required host libraries optional merely to suppress install warnings. In particular, root `bunderstack` statically uses Better Auth, Hono, Zod, and tRPC today, so those peers are required until a future core feature-plugin redesign removes those static imports.

- [ ] **Step 4: Refresh the lockfile with Bun**

```bash
bun install
```

Expected: `bun.lock` changes only as required by manifest reclassification; no unrelated package upgrades.

- [ ] **Step 5: Verify manifest and package tests**

```bash
bun test scripts/dependency-boundaries.test.ts
bun run typecheck
bun run test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json scripts/dependency-boundaries.test.ts bun.lock
git commit -m "chore: align peer dependencies with package boundaries"
```

---

### Task 7: Migrate workspace examples to explicit imports

**Files:**

- Modify: every `examples/*/src/bunderstack.ts` using `createBunderstack`
- Modify: examples importing `createClient` where tRPC is used
- Modify: `examples/*/src/utils/auth-client.ts`
- Modify: affected example `package.json` files

**Interfaces:**

- Consumes: new adapter, tRPC client, schema client, and Start auth subpaths.
- Produces: examples that demonstrate the intended dependency ownership model.

- [ ] **Step 1: Add explicit database adapters**

For each sqlite/libSQL example, add:

```ts
import { libsql } from 'bunderstack/database/libsql'
```

and change database configuration to:

```ts
database: {
  adapter: libsql(),
  url: process.env.DATABASE_URL ?? 'file:./data.db',
}
```

For pg/PGlite examples, use `pglite()` for local embedded Postgres. If an example intentionally targets a server Postgres under Bun, use `bunSql()` and require a Postgres URL; do not select between adapters from a computed runtime import.

If the same module must support deployment introspection, statically import both its production adapter and `pglite`, then choose the adapter value using `BUNDERSTACK_INTROSPECT` as shown in the Target public API section. Add `@electric-sql/pglite` as an explicit dependency in that application.

- [ ] **Step 2: Migrate query imports**

Code that accesses `api.trpc` must import:

```ts
import { createTRPCClient } from 'bunderstack-query/trpc'
```

and call `createTRPCClient<App>()`. REST-only code continues to import `createClient` from root. Runtime-schema code imports `createBunderstackSchemaClient` from `bunderstack-query/schema`.

- [ ] **Step 3: Migrate Start auth imports**

Replace:

```ts
import { createStartAuthClient } from 'bunderstack-start'
```

with:

```ts
import { createStartAuthClient } from 'bunderstack-start/auth'
```

- [ ] **Step 4: Make peer ownership explicit in example manifests**

Each example must directly declare every peer it consumes through its selected subpaths:

- all server examples: `better-auth`, `drizzle-orm`, `hono`, `zod`, and the selected database client;
- examples using server tRPC: `@trpc/server`;
- examples using `bunderstack-query/trpc`: `@trpc/client`, `@trpc/server`, `@trpc/tanstack-react-query`, `@tanstack/react-query`;
- examples using Start auth: `better-auth`;
- `drizzle-kit` stays a dev dependency.

- [ ] **Step 5: Run example builds**

Run the build script for every example that defines one:

```bash
bun run --cwd examples/todo build
bun run --cwd examples/twitter-tanstack build
bun run --cwd examples/twitter-db-tanstack build
bun run --cwd examples/tldraw build
bun run --cwd examples/kanban-tanstack build
```

For `kanban-solid-1.9`, run its declared build or typecheck command from its `package.json`. Expected: every build succeeds without Vite warnings about unanalyzable dynamic imports from Bunderstack source.

- [ ] **Step 6: Commit**

```bash
git add examples bun.lock
git commit -m "refactor: migrate examples to explicit integrations"
```

---

### Task 8: Update documentation and migration guidance

**Files:**

- Modify: `README.md`
- Modify: `examples/README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `packages/bunderstack-query/README.md`
- Modify: `packages/bunderstack-sync/README.md`
- Modify: `packages/bunderstack-start/README.md`
- Create: `docs/dependency-model.md`

**Interfaces:**

- Consumes: final public API and peer dependency tables.
- Produces: install instructions and a pre-1.0 migration guide with no obsolete dynamic-driver advice.

- [ ] **Step 1: Document the dependency model**

`docs/dependency-model.md` must explain:

- regular dependency: private implementation detail, one compatible copy may be nested;
- required peer: host instance/version exposed through public API;
- optional peer: only an explicit subpath requires it;
- dev dependency: needed to test/typecheck the package itself;
- TypeScript is an optional `>=5` peer because packages publish `.ts`, while Bun/Vite users are not forced to install `tsc`;
- literal dynamic import is analyzable; computed imports and ignore comments are forbidden.

Include a table listing every dependency in all four manifests and its classification.

- [ ] **Step 2: Update install and quick-start snippets**

Every `createBunderstack` snippet must select a database adapter. Every tRPC client and Start auth snippet must use its new subpath. SMTP docs must show `smtp({ url })` and an explicit `nodemailer` install.

- [ ] **Step 3: Add migration notes**

Document these breaking changes:

```text
database.adapter is now required
email.provider: 'smtp' -> email.provider: smtp({ url })
createClient with tRPC -> createTRPCClient from bunderstack-query/trpc
withSchema -> createBunderstackSchemaClient from bunderstack-query/schema
createStartAuthClient -> bunderstack-start/auth
TypeScript peer range ^5 -> optional >=5
```

- [ ] **Step 4: Check docs for stale imports and instructions**

```bash
rg "provider: ['\"]smtp|createStartAuthClient.*bunderstack-start['\"]|@vite-ignore|webpackIgnore|importDriver|database: \{ url" README.md examples packages docs/dependency-model.md
```

Expected: no stale code examples. Historical design/plan documents under `docs/superpowers` may retain old decisions and are excluded from this check.

- [ ] **Step 5: Commit**

```bash
git add README.md examples/README.md packages/*/README.md docs/dependency-model.md
git commit -m "docs: explain static integration boundaries"
```

---

### Task 9: Add bundle budgets and perform final verification

**Files:**

- Create: `scripts/bundle-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: final public entrypoints.
- Produces: automated protection against server/tRPC/auth code leaking back into lightweight browser bundles.

- [ ] **Step 1: Write Bun.Build metafile tests**

The test must build these entrypoints for `target: 'browser'`, `minify: true`, and inspect `result.metafile.inputs`:

```ts
const cases = [
  {
    entry: 'packages/bunderstack-query/src/index.ts',
    forbidden: ['packages/bunderstack/src/', '@trpc', 'superjson'],
  },
  {
    entry: 'packages/bunderstack-start/src/index.ts',
    forbidden: ['/better-auth/'],
  },
]
```

Use `Bun.build({ entrypoints: [join(root, entry)], target: 'browser', minify: true, metafile: true, write: false, external: entry.includes('bunderstack-start') ? ['@tanstack/react-start/server'] : [] })`. Assert `result.success`, then assert no normalized input path contains a forbidden fragment. For the Start case, also assert the output retains `@tanstack/react-start/server` as an external literal import. Assert the lightweight query output is at most `32 * 1024` bytes.

- [ ] **Step 2: Verify the bundle tests**

```bash
bun test scripts/bundle-boundaries.test.ts
```

Expected: PASS. The Start browser build represents the React Start server module as an explicit external literal import; it is never suppressed with an ignore comment.

- [ ] **Step 3: Add the convenience script**

```json
"test:bundles": "bun test scripts/bundle-boundaries.test.ts"
```

Root `bun run test` already includes `scripts/`; keep one canonical full-test path.

- [ ] **Step 4: Run the complete verification matrix**

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:boundaries
bun run test:bundles
```

Then rerun every example build listed in Task 7. Expected: all commands exit 0, the lockfile is unchanged by frozen install, and Vite prints no Bunderstack dynamic-import analysis warnings.

- [ ] **Step 5: Inspect the final diff for dependency regressions**

```bash
git diff --check
git status --short
rg -n "@vite-ignore|webpackIgnore|importDriver|import\([^'\"]" packages/*/src --glob '!**/*.test.*'
```

Expected: `git diff --check` succeeds; the final `rg` has no matches.

- [ ] **Step 6: Commit the verification guard**

```bash
git add package.json scripts/bundle-boundaries.test.ts
git commit -m "test: enforce browser bundle boundaries"
```

---

## Explicitly deferred follow-up

The root `bunderstack` package still statically owns Better Auth, Hono, Zod, and the current tRPC server integration. This plan converts those packages to application-owned peers but does not redesign `createBunderstack({ trpc })` into a general feature-plugin API. That redesign would affect contextual generic inference and deserves a separate design/implementation plan. The present plan removes non-analyzable optional module discovery and the largest browser leaks without coupling it to that higher-risk API change.

## Final acceptance criteria

- No published source contains `@vite-ignore`, `webpackIgnore`, or computed `import()`.
- Every database engine and SMTP is selected by an explicit statically imported adapter.
- `bunderstack-query` root browser graph contains no `bunderstack`, Drizzle, tRPC, or SuperJSON runtime module.
- `bunderstack-start` root graph contains no Better Auth runtime module.
- Host frameworks are peers; private implementation packages remain dependencies.
- TypeScript is an optional `>=5` peer in all four packages.
- All package tests, typechecks, dependency tests, bundle tests, and example Vite builds pass.
- Documentation contains a complete migration path for every breaking import/configuration change.
