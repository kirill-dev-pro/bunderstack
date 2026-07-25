# Static Dependency Boundaries & Type Safety Cleanups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a complete standalone remediation for PR #6 (head `650541d`), closing database connection leaks, ensuring offline introspection, removing published `@ts-nocheck` directives, fixing peer metadata, eliminating four identified avoidable `any` usages, and establishing typecheck coverage across all workspace examples.

**Architecture:** Database adapters expose a `close` handle in `DatabaseConnectionResult`; `createBunderstack` registers cleanup with `Lifecycle`; offline introspection returns `drizzle.mock()`; package manifests declare accurate peers (`better-auth` required, `nodemailer` optional); browser bundles are strictly tested (<32KiB); avoidable `any` types are replaced with strict generic or structural type guards; workspace examples are included in `typecheck:examples`.

**Starting Point:** Branch `static-dependency-boundaries` at commit `650541d` (PR #6 Head).

**Tech Stack:** Bun, TypeScript, Drizzle ORM, Zod, TanStack Query/DB, tRPC, Better Auth, Nodemailer.

## Global Constraints

- Use Bun for scripts, tests, and builds.
- TypeScript range in `peerDependencies` must be `>=5`.
- Do NOT introduce `@ts-nocheck`, `any`, or unsafe type suppressions in published package sources or workspace examples.
- Do NOT introduce `@vite-ignore`, `webpackIgnore`, or computed dynamic `import()` calls.

---

### Task 1: Consolidate Database Adapter Lifecycle & Introspection

**Files:**
- Modify: `packages/bunderstack/src/database/adapter.ts`
- Modify: `packages/bunderstack/src/database/libsql.ts`
- Modify: `packages/bunderstack/src/database/pglite.ts`
- Modify: `packages/bunderstack/src/database/bun-sql.ts`
- Modify: `packages/bunderstack/src/database/postgres-js.ts`
- Modify: `packages/bunderstack/src/db.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/db.test.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`
- Test: `packages/bunderstack/src/database/adapter.test.ts`

**Interfaces:**
- Consumes: `DbFor<TSchema>`, `Driver`, `Dialect`, `Lifecycle`.
- Produces:
  ```ts
  export type DatabaseConnectionResult<TSchema extends Record<string, unknown>> = {
    db: DbFor<TSchema>
    close?: () => void | Promise<void>
  }
  ```
  and offline `drizzle.mock()` when `{ introspect: true }`.

- [ ] **Step 1: Write lifecycle regression tests in `db.test.ts` and `app-env.test.ts`**

Add to `packages/bunderstack/src/db.test.ts`:
```ts
test('createDb returns adapter cleanup', async () => {
  let closed = false
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      return {
        db: drizzle.mock({ schema }),
        close: () => { closed = true },
      } as never
    },
    async migrate() {},
  }

  const connection = await createDb(schema, {
    adapter,
    dialect: 'sqlite',
    url: ':memory:',
    introspect: false,
  })
  await connection.close?.()
  expect(closed).toBe(true)
})
```

Add to `packages/bunderstack/src/app-env.test.ts`:
```ts
test('app.close() closes database adapter exactly once and is idempotent', async () => {
  let closeCount = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      return {
        db: drizzle.mock({ schema: {} }),
        close: () => { closeCount++ },
      } as never
    },
    async migrate() {},
  }

  const app = await createBunderstack({ schema: {}, database: { adapter } })
  await app.close()
  expect(closeCount).toBe(1)
  await app.close()
  expect(closeCount).toBe(1)
})
```

- [ ] **Step 2: Run lifecycle tests to verify initial failure on `650541d`**

Run: `bun test --cwd packages/bunderstack src/db.test.ts src/app-env.test.ts`
Expected: FAIL on `650541d` because adapters do not expose `close` and `app.close()` does not close DB connections.

- [ ] **Step 3: Implement `DatabaseConnectionResult` and adapter cleanup**

In `packages/bunderstack/src/database/adapter.ts`, update `DatabaseAdapter` `connect` return type to `Promise<DatabaseConnectionResult<TSchema>>`.

In each built-in adapter (`libsql.ts`, `pglite.ts`, `bun-sql.ts`, `postgresJs.ts`), return the underlying `$client.close()` or `$client.end()` callback.

In `packages/bunderstack/src/index.ts`, register `close` handle with `lifecycle` immediately after `createDb`:
```ts
const lifecycle = new Lifecycle()
const { db, driver, close: closeDatabase } = await createDb(mergedSchema, {
  ...config.database,
  dialect,
  introspect,
})
if (closeDatabase) lifecycle.add(closeDatabase)
```

- [ ] **Step 4: Implement offline introspection**

In each built-in adapter's `connect()`, check `{ introspect }`:
```ts
async connect(schema, connection, { introspect }) {
  if (introspect) return { db: drizzle.mock({ schema }) as never }
  // ... real connection construction
}
```

- [ ] **Step 5: Run tests and verify PASS**

Run: `bun test --cwd packages/bunderstack src/db.test.ts src/app-env.test.ts src/database/adapter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/database/ packages/bunderstack/src/db.ts packages/bunderstack/src/index.ts packages/bunderstack/src/db.test.ts packages/bunderstack/src/app-env.test.ts
git commit -m "fix: close database adapter connections and keep introspection offline"
```

---

### Task 2: Remove `@ts-nocheck`, Align Peer Metadata & Enforce Bundle Boundaries

**Files:**
- Modify: `packages/bunderstack/src/auth.ts`
- Modify: `packages/bunderstack-start/src/isomorphic-fetch.ts`
- Modify: `packages/bunderstack/package.json`
- Create: `scripts/bundle-boundaries.test.ts`
- Modify: `scripts/dependency-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: published package sources, package manifests, and `Bun.build`.
- Produces: clean published TypeScript source without `@ts-nocheck`, accurate peer dependencies, and browser bundle size tests.

- [ ] **Step 1: Remove `@ts-nocheck` from published sources**

In `packages/bunderstack/src/auth.ts` and `packages/bunderstack-start/src/isomorphic-fetch.ts`, remove the top-level `// @ts-nocheck` comments and fix any underlying type errors cleanly.

- [ ] **Step 2: Add `@ts-nocheck` boundary assertion to `dependency-boundaries.test.ts`**

Add to `scripts/dependency-boundaries.test.ts`:
```ts
test('published package source does not disable TypeScript checking', async () => {
  const glob = new Bun.Glob('packages/*/src/**/*.{ts,tsx}')
  const offenders: string[] = []
  for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    const source = await Bun.file(join(repoRoot, path)).text()
    if (source.includes('@ts-nocheck')) offenders.push(path)
  }
  expect(offenders).toEqual([])
})
```

- [ ] **Step 3: Create `[NEW] scripts/bundle-boundaries.test.ts`**

Create `scripts/bundle-boundaries.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

async function bundle(entrypoint: string, external: string[] = []) {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, entrypoint)],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: true,
    sourcemap: 'none',
    metafile: true,
    external,
    write: false,
  })
  expect(result.success, result.logs.map(String).join('\n')).toBe(true)
  expect(result.outputs).toHaveLength(1)
  const output = result.outputs[0]!
  return {
    text: await output.text(),
    size: output.size,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  }
}

describe('browser bundle boundaries', () => {
  test('query root stays schema-only', async () => {
    const output = await bundle('packages/bunderstack-query/src/index.ts')
    expect(output.size).toBeLessThan(32 * 1024)
    expect(output.inputs.some((path) => path.includes('@tanstack/react-query'))).toBe(false)
    expect(output.inputs.some((path) => path.includes('@trpc'))).toBe(false)
    expect(output.inputs.some((path) => path.includes('superjson'))).toBe(false)
    expect(output.inputs.some((path) => path.includes('better-auth'))).toBe(false)
  })
})
```

- [ ] **Step 4: Align `packages/bunderstack/package.json` peerDependencies**

Update `packages/bunderstack/package.json`:
- `better-auth`: `^1.0.0` in `peerDependencies` (remove from `peerDependenciesMeta`).
- `nodemailer`: `>=6 <10` in `peerDependencies` (keep optional in `peerDependenciesMeta`).

- [ ] **Step 5: Run boundary tests**

Run: `bun test scripts/dependency-boundaries.test.ts scripts/bundle-boundaries.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/auth.ts packages/bunderstack-start/src/isomorphic-fetch.ts packages/bunderstack/package.json scripts/
git commit -m "fix: remove ts-nocheck, align peer metadata, and enforce bundle boundaries"
```

---

### Task 3: Eliminate Four Identified Avoidable `any` Usages

**Files:**
- Modify: `packages/bunderstack-query/src/trpc.ts`
- Modify: `packages/bunderstack/src/email/smtp.ts`
- Modify: `packages/bunderstack-query/src/realtime-client.ts`
- Modify: `packages/bunderstack/src/config.ts`

**Interfaces:**
- Consumes: `TRPCOptionsProxy`, `TransportFactory`, `RealtimeEvent`, `BunderstackOptionsSchema`.
- Produces: type-safe implementations with zero `any` in these 4 targets.

- [ ] **Step 1: Refactor `trpcProxy` in `packages/bunderstack-query/src/trpc.ts`**

Replace `let trpcProxy: any` on line 47 with:
```ts
let trpcProxy: TRPCOptionsProxy<AnyRouter> | undefined
```

- [ ] **Step 2: Refactor `createTransport` in `packages/bunderstack/src/email/smtp.ts`**

Replace `nodemailer.createTransport(url) as any` on line 12 with:
```ts
type SmtpTransport = {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>
}

export function createSmtpAdapter(
  options: { url: string },
  createTransport: (url: string) => SmtpTransport = (url) =>
    nodemailer.createTransport(url) as unknown as SmtpTransport,
): EmailAdapter
```

- [ ] **Step 3: Refactor `clientId` handling in `packages/bunderstack-query/src/realtime-client.ts`**

Replace `(data as any).clientId` on lines 161 & 163 with:
```ts
const candidate = (data as { clientId?: unknown }).clientId
if (typeof candidate === 'string' && candidate.length > 0) {
  clientId = candidate
  if (lastTopics.length) void postSubscribe(lastTopics)
  return
}
```

- [ ] **Step 4: Refactor Zod schema in `packages/bunderstack/src/config.ts`**

Replace `z.any()` on lines 25 and 28 with:
```ts
access: z.record(z.string(), z.unknown()).optional(),
database: z
  .object({
    adapter: z.unknown(),
    url: z.string().optional(),
    authToken: z.string().optional(),
    migrations: z.string().optional(),
  })
  .optional(),
```

- [ ] **Step 5: Run typecheck and core tests**

Run: `bun run typecheck && bun run test`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack-query/src/trpc.ts packages/bunderstack/src/email/smtp.ts packages/bunderstack-query/src/realtime-client.ts packages/bunderstack/src/config.ts
git commit -m "refactor: eliminate identified avoidable any types in core packages"
```

---

### Task 4: Add `typecheck:examples` & Fix Workspace Examples TypeScript Errors

**Files:**
- Modify: `package.json`
- Modify: `examples/todo/tsconfig.json`
- Modify: `examples/tldraw/src/routes/canvas.tsx`
- Modify: `examples/tldraw/src/routes/canvas.$id.tsx`
- Modify: `examples/kanban-tanstack/src/vite-env.d.ts` (or create if missing)

**Interfaces:**
- Consumes: Bun types, TanStack DB collection types, oat.min.js declarations.
- Produces: 100% clean typecheck across all workspace examples without using `@ts-nocheck`, `any`, or unsafe casts.

- [ ] **Step 1: Add `typecheck:examples` and `typecheck:all` to root `package.json`**

Add to `package.json` `scripts`:
```json
"typecheck:examples": "bunx tsc --noEmit -p examples/todo/tsconfig.json && bunx tsc --noEmit -p examples/tldraw/tsconfig.json && bunx tsc --noEmit -p examples/kanban-tanstack/tsconfig.json && bunx tsc --noEmit -p examples/twitter-tanstack/tsconfig.json && bunx tsc --noEmit -p examples/twitter-db-tanstack/tsconfig.json",
"typecheck:all": "bun run typecheck && bun run typecheck:examples"
```

- [ ] **Step 2: Add Bun types to `examples/todo/tsconfig.json`**

In `examples/todo/tsconfig.json`, add `"bun"` to `compilerOptions.types`:
```json
"compilerOptions": {
  "types": ["bun"]
}
```

- [ ] **Step 3: Fix `examples/tldraw` type errors cleanly**

In `examples/tldraw/src/routes/canvas.tsx` and `canvas.$id.tsx`, resolve TanStack DB collection generic type incompatibilities by aligning collection schema generics rather than applying `@ts-nocheck` or `as any`.

- [ ] **Step 4: Fix `examples/kanban-tanstack` type declarations**

Add declaration for `oat.min.js` in `examples/kanban-tanstack/src/vite-env.d.ts` or tsconfig types.

- [ ] **Step 5: Run full verification suite**

Run: `bun run typecheck:all && bun run test`
Expected: ALL PASS with 0 errors across packages and examples.

- [ ] **Step 6: Commit**

```bash
git add package.json examples/
git commit -m "fix: establish typecheck:examples and resolve workspace examples type errors"
```
