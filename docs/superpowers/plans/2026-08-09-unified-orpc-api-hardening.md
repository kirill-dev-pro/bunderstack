# Unified oRPC API Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working unified oRPC spike into an honestly end-to-end type-safe experiment with one CRUD execution core, strict startup collision validation, and reproducible OpenAPI client generation.

**Architecture:** Keep the existing oRPC runtime topology and unchanged HTTP URLs. Thread the inferred custom router and generated CRUD router through `createBunderstack`, `$inferClient`, `createClient`, `RouterClient`, and TanStack Query utilities without public `any`; make Hono and oRPC thin adapters over shared CRUD operations; normalize all routes before validating or merging OpenAPI documents.

**Tech Stack:** Bun, TypeScript, oRPC `2.0.0-beta.26`, Zod 4, drizzle-zod, Drizzle ORM, Hono, Better Auth, TanStack Query, openapi-typescript `7.13.0`.

## Design Decision

Use a shared CRUD execution core with two temporary adapters: the existing Hono adapter for compatibility and the oRPC adapter for the new API. A smaller patch that only fixes client types would leave two implementations of authorization, scoping, idempotency, and realtime publication; removing Hono CRUD immediately would make this hardening pass unnecessarily breaking. The shared-core approach is the only option that both respects the spike constraints and leaves one source of behavioral truth.

## Global Constraints

- Work only on branch `experiment/orpc-api` in the existing `orpc-api-spike` worktree.
- Read `AGENTS.md` first and use Bun for every command.
- Do not add API versioning or change `/api/<table>`, `/api/<table>/{id}`, `/api/auth/*`, `/api/rpc/*`, or `/api/openapi.json`.
- Keep legacy `trpc:` and `routes:` operational during this pass.
- Do not remove the legacy Hono CRUD adapter yet; make it delegate to the shared CRUD core.
- Do not change successful CRUD payloads, status codes, error envelopes, idempotency replay headers, access behavior, scoping, or realtime publication behavior.
- Public API declarations and type-level tests must not use `any`, `as any`, or hand-written handler argument annotations. Narrow internal casts are allowed only at dynamic schema iteration or Proxy construction boundaries and must not escape exported types.
- Keep all oRPC packages pinned to exactly `2.0.0-beta.26`.
- Do not commit generated OpenAPI clients, PGlite data directories, or other test artifacts.
- Use TDD for every task and commit after every independently passing task.
- Stop and record `NO-GO` if the unified router cannot flow from `createBunderstack()` into `createClient<typeof app>()` with correct procedure inputs and outputs, or if CRUD requires two independently maintained behavior/schema models.

---

### Task 1: Thread the custom oRPC router type through the server application

**Files:**

- Modify: `packages/bunderstack/src/api/builder.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/api/builder.test.ts`
- Create: `packages/bunderstack/src/api/api-types.types.ts`

**Interfaces:**

- Produces: `BunderstackApiBuilder<TSchema, TEnv> = ReturnType<typeof createApiBuilder<TSchema, TEnv>>`.
- Produces: a `TCustomApiRouter extends AnyRouter | undefined` generic on `BunderstackConfig` and `BunderstackApp`.
- Produces: `$inferClient.api` containing the final unified router type, not merely the custom router.
- Preserves: contextual types for `o`, `input`, `context`, `context.user`, and `context.session` inside `api:` callbacks.

- [ ] **Step 1: Add failing contextual-type assertions**

Add a compile-time fixture that declares an app without `as any`:

```ts
const app = await createBunderstack({
  schema: { posts },
  database: { adapter: pglite() },
  processEnv: {
    DATABASE_URL: 'file:./api-types.pglite',
    BUNDERSTACK_ROLE: 'web',
  },
  access: { posts: { crud: true, list: 'public' } },
  api: (o) => ({
    stats: o.protected
      .input(z.object({ period: z.enum(['day', 'week']) }))
      .output(z.object({ period: z.enum(['day', 'week']), userId: z.string() }))
      .handler(async ({ input, context }) => ({
        period: input.period,
        userId: context.user.id,
      })),
  }),
})

type ApiCarrier = NonNullable<typeof app.$inferClient>['api']
type _ApiWasCaptured = Expect<
  Equal<'stats' extends keyof ApiCarrier ? true : false, true>
>
```

Also assert that `context.user.id`, the validated env, and `context.db` are inferred without explicit handler annotations.

- [ ] **Step 2: Run the focused typecheck and verify failure**

Run:

```bash
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: failure because `api` currently receives `any` and `$inferClient` has no `api` property.

- [ ] **Step 3: Export the builder type and add the custom router generic**

Use the oRPC `AnyRouter` constraint and define the callback in terms of the real builder:

```ts
import type { AnyRouter } from '@orpc/server'

export type BunderstackApiBuilder<
  TSchema extends Record<string, unknown>,
  TEnv,
> = ReturnType<typeof createApiBuilder<TSchema, TEnv>>

export type ApiFactory<
  TSchema extends Record<string, unknown>,
  TEnv,
  TCustomApiRouter extends AnyRouter,
> = (builder: BunderstackApiBuilder<TSchema, TEnv>) => TCustomApiRouter
```

Add `TCustomApiRouter` to `BunderstackConfig`, every `createBunderstack` overload, the implementation signature, and `BunderstackApp`. Preserve the callback return type rather than widening it to `Record<string, unknown>`.

- [ ] **Step 4: Add the final API router to the phantom carrier**

Extend the carrier shape:

```ts
readonly $inferClient?: {
  schema: TSchema
  access: TAccess
  buckets: TBuckets
  trpc: TRouter
  api: TApiRouter
}
```

At this task, `TApiRouter` may temporarily equal `TCustomApiRouter`; Task 2 replaces it with the merged CRUD-plus-custom type. Do not assign `$inferClient` at runtime.

- [ ] **Step 5: Remove type escapes from the representative API declarations**

Update the type fixture and existing builder tests so `api: (o)` and handlers rely on contextual inference. Do not silence failures with explicit `{ context: any; input: any }` annotations.

- [ ] **Step 6: Run focused verification**

Run:

```bash
bun test --cwd packages/bunderstack src/api/builder.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: both commands pass and the negative type assertions remain active.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/api/builder.ts packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/api/builder.test.ts packages/bunderstack/src/api/api-types.types.ts
git commit -m "fix(api): preserve custom orpc router inference"
```

---

### Task 2: Give generated CRUD procedures real schema/access types

**Files:**

- Modify: `packages/bunderstack/src/api/crud-router.ts`
- Create: `packages/bunderstack/src/api/types.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `bun.lock`
- Test: `packages/bunderstack/src/api/crud-router.test.ts`
- Modify: `packages/bunderstack/src/api/api-types.types.ts`

**Interfaces:**

- Produces: `CrudApiRouterFor<TSchema, TAccess>` containing only exposed table keys.
- Produces: typed `list`, `get`, `create`, `update`, and `delete` procedures for each table.
- Produces: `UnifiedApiRouter<TSchema, TAccess, TCustomApiRouter>` used by `BunderstackApp.$inferClient.api`.
- Uses: drizzle-zod insert/select schemas and partial insert schema excluding immutable `id`.

- [ ] **Step 1: Add failing positive and negative CRUD type assertions**

Use one exposed and one disabled table:

```ts
const typedApp = await createBunderstack({
  schema: { posts, privateNotes },
  database: { adapter: pglite() },
  processEnv: {
    DATABASE_URL: 'file:./crud-api-types.pglite',
    BUNDERSTACK_ROLE: 'web',
  },
  access: {
    posts: { crud: true, list: 'public', create: 'public' },
    privateNotes: { crud: false },
  },
})

type Api = NonNullable<typeof typedApp.$inferClient>['api']
type _HasPosts = Expect<Equal<'posts' extends keyof Api ? true : false, true>>
type _HidesPrivateNotes = Expect<
  Equal<'privateNotes' extends keyof Api ? true : false, false>
>
```

Add compile-time assertions that `posts.create` accepts the Drizzle insert type, `posts.get` requires `{ id: string }`, `posts.update` rejects `id` inside its mutable body, and `posts.list` returns rows with the actual post columns.

- [ ] **Step 2: Verify the assertions fail**

Run:

```bash
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: failure because `TableCrudProcedures` is `any` and `CrudApiRouterFor` ignores access.

- [ ] **Step 3: Extract a typed single-table procedure factory**

Replace the untyped `TableCrudProcedures` declaration with the return type of a generic factory:

```ts
function buildTableCrudProcedures<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  // construct the five procedures here
  return { list, get, create, update, delete: deleteProc }
}

export type TableCrudProcedures<TTable extends Table> = ReturnType<
  typeof buildTableCrudProcedures<Record<string, unknown>, TTable>
>
```

Keep unavoidable casts inside the `Object.entries(schema)` loop; do not type the returned procedures as `any`.

- [ ] **Step 4: Mirror the existing access exposure rules on the server**

Move the existing exposure rules from `bunderstack-query/src/infer.ts` into `bunderstack/src/api/types.ts`, using the same concrete definitions:

```ts
type AuthTableName = 'user' | 'session' | 'account' | 'verification'
type InferSelect<T> = T extends { $inferSelect: infer R } ? R : never
type CrudApiTableKey<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName ? never : K
}[keyof TSchema & string]

type DisabledKeys<TAccess> = {
  [K in keyof TAccess & string]: TAccess[K] extends { crud: false } ? K : never
}[keyof TAccess & string]

type ExplicitKeys<TSchema, TAccess> = {
  [K in keyof TAccess & keyof TSchema & string]: TAccess[K] extends {
    crud: false
  }
    ? never
    : K extends AuthTableName
      ? TAccess[K] extends { exposeAuthTable: true }
        ? K extends 'user'
          ? K
          : never
        : never
      : K
}[keyof TAccess & keyof TSchema & string]

type ConventionKeys<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName
    ? never
    : InferSelect<TSchema[K]> extends { userId: unknown }
      ? K
      : never
}[keyof TSchema & string]

export type ExposedApiTables<TSchema, TAccess> = [TAccess] extends [undefined]
  ? CrudApiTableKey<TSchema>
  :
      | ExplicitKeys<TSchema, TAccess>
      | Exclude<
          ConventionKeys<TSchema>,
          DisabledKeys<TAccess> | (keyof TAccess & string)
        >
```

Use it in:

```ts
export type CrudApiRouterFor<TSchema, TAccess> = {
  [K in ExposedApiTables<TSchema, TAccess> as TSchema[K] extends Table
    ? K
    : never]: TableCrudProcedures<Extract<TSchema[K], Table>>
}
```

There must be one exported exposure utility consumed by `bunderstack-query`; do not leave divergent server/client copies.

- [ ] **Step 5: Use the generated partial update schema**

Replace `z.any().optional()` update fields with the existing drizzle-zod partial insert shape:

```ts
const mutableUpdateSchema = insertSchema.omit({ id: true }).partial()
const updateInputSchema = z.object({
  id: z.string(),
  ...mutableUpdateSchema.shape,
})
```

Add runtime tests proving invalid column values return `400` and the OpenAPI PATCH request schema describes concrete column types rather than unrestricted values.

Keep the list output schema identical to the established Hono response: `items`, pagination metadata, and no synthetic duplicate `data` field. Optional fields must remain omitted when absent rather than being rewritten to `null`.

- [ ] **Step 6: Type the merged router without changing runtime semantics**

Export a recursive type that rejects overlapping leaf handles and combines distinct namespaces:

```ts
export type UnifiedApiRouter<
  TCrud extends AnyRouter,
  TCustom extends AnyRouter | undefined,
> = TCustom extends AnyRouter ? MergeApiRouterTypes<TCrud, TCustom> : TCrud
```

Use the type as `BunderstackApp`'s API carrier while retaining the runtime merge until Task 4 hardens collision handling.

- [ ] **Step 7: Run focused verification**

Before verification, declare every package imported by shipped runtime code in the published package contract. Add `@orpc/server`, `@orpc/openapi`, `@orpc/zod`, and `drizzle-zod` to `packages/bunderstack/package.json` peer dependencies while retaining exact matching development dependencies for the workspace. Keep all oRPC versions at `2.0.0-beta.26` and regenerate `bun.lock` with `bun install`.

Run:

```bash
bun test --cwd packages/bunderstack src/api/crud-router.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: runtime and compile-time tests pass without public `any`.

- [ ] **Step 8: Commit**

```bash
git add packages/bunderstack/src/api/crud-router.ts packages/bunderstack/src/api/types.ts packages/bunderstack/src/index.ts packages/bunderstack/src/api/crud-router.test.ts packages/bunderstack/src/api/api-types.types.ts packages/bunderstack/package.json bun.lock
git commit -m "fix(api): infer generated crud procedure types"
```

---

### Task 3: Make `createClient<typeof app>().api` end-to-end type-safe

**Files:**

- Modify: `packages/bunderstack-query/src/infer.ts`
- Modify: `packages/bunderstack-query/src/api.ts`
- Modify: `packages/bunderstack-query/src/client.ts`
- Modify: `packages/bunderstack-query/src/index.ts`
- Modify: `packages/bunderstack-query/package.json`
- Test: `packages/bunderstack-query/tests/api-client.test.ts`
- Create: `packages/bunderstack-query/tests/api-client-types.types.ts`

**Interfaces:**

- Produces: `InferApiRouter<TApp>` from `$inferClient.api`.
- Produces: `ApiQueryUtils<TRouter> = RouterUtils<RouterClient<TRouter>>`.
- Produces: `createApiClient<TRouter>(options): ApiQueryUtils<TRouter>`.
- Produces: `BunderstackClient<TApp>['api'] = ApiQueryUtils<InferApiRouter<TApp>>`.

- [ ] **Step 1: Replace runtime tests that currently cast `client.api` to `any`**

The test must compile and execute these calls directly:

```ts
const listOptions = client.api.posts.list.queryOptions({ input: {} })
const statsOptions = client.api.stats.get.queryOptions({
  input: { id: 'stat_1' },
})

const result = await statsOptions.queryFn(queryContext)
expect(result.totalPosts).toBe(42)
```

Remove `as any` from the app configuration, API builder callback, `client.api`, and handler arguments in this test.

- [ ] **Step 2: Add negative compile-time tests**

Add active checks:

```ts
client.api.stats.get.queryOptions({ input: { id: 'ok' } })

// @ts-expect-error id is required
client.api.stats.get.queryOptions({ input: {} })

// @ts-expect-error totalPosts is a number
const wrongOutput: string = await client.api.stats.get
  .queryOptions({
    input: { id: 'ok' },
  })
  .queryFn(queryContext)

// @ts-expect-error route does not exist
client.api.missing.get.queryOptions({ input: {} })

// @ts-expect-error disabled CRUD table is not exposed
client.api.privateNotes.list.queryOptions({ input: {} })
```

- [ ] **Step 3: Verify the type tests fail for the current `any` client**

Run:

```bash
bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json
```

Expected: unused `@ts-expect-error` directives, proving the current client accepts invalid calls.

- [ ] **Step 4: Derive the oRPC client and query utility types**

Use oRPC's exported types instead of reconstructing its procedure shape:

```ts
import type { AnyRouter, RouterClient } from '@orpc/server'
import type { RouterUtils } from '@orpc/tanstack-query'

export type ApiQueryUtils<TRouter extends AnyRouter> = RouterUtils<
  RouterClient<TRouter>
>

export function createApiClient<TRouter extends AnyRouter>(
  options: ApiClientOptions = {},
): ApiQueryUtils<TRouter> {
  const client = createORPCClient<RouterClient<TRouter>>(link)
  return createTanstackQueryUtils(client)
}
```

Internal link/fetch adaptation casts may remain if required by DOM/Bun fetch variance, but the generic router, returned client, and query utils must not be `any`.

- [ ] **Step 5: Connect the application carrier to `BunderstackClient`**

Extend `ClientCarrier` and inference:

```ts
export type ClientCarrier = {
  schema: Record<string, unknown>
  access: unknown
  buckets: string
  trpc?: unknown
  api: AnyRouter
}

export type InferApiRouter<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['api']
```

Then declare:

```ts
export type BunderstackClient<TApp extends AnyBunderstackApp> =
  RestBunderstackClient<TApp> & {
    api: ApiQueryUtils<InferApiRouter<TApp>>
  }
```

Construct the lazy Proxy with a narrow internal assertion to this exported type.

- [ ] **Step 6: Keep the lightweight schema entrypoint clean**

Ensure oRPC runtime imports remain outside `bunderstack-query/schema`. Add `@orpc/server` at `2.0.0-beta.26` to `bunderstack-query` peer dependencies because its exported `ApiQueryUtils` type references `RouterClient`; keep the import type-only.

- [ ] **Step 7: Run focused verification**

Run:

```bash
bun test --cwd packages/bunderstack-query tests/api-client.test.ts
bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json
bun run test:boundaries
bun run test:bundles
```

Expected: runtime test, positive/negative type assertions, and bundle boundaries all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/bunderstack-query/src/infer.ts packages/bunderstack-query/src/api.ts packages/bunderstack-query/src/client.ts packages/bunderstack-query/src/index.ts packages/bunderstack-query/package.json packages/bunderstack-query/tests/api-client.test.ts packages/bunderstack-query/tests/api-client-types.types.ts bun.lock
git commit -m "fix(query): infer unified orpc query utilities"
```

---

### Task 4: Make route and OpenAPI collision validation strict and canonical

**Files:**

- Modify: `packages/bunderstack/src/api/registry.ts`
- Modify: `packages/bunderstack/src/api/openapi.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/api/registry.test.ts`
- Test: `packages/bunderstack/src/api/openapi.test.ts`

**Interfaces:**

- Produces: `normalizeApiPath(path, prefix?)` shared by registry and OpenAPI merge.
- Produces: `normalizeForeignOpenAPISpec(spec, { prefix: '/api/auth' })` before registry construction.
- Produces: `mergeApiRoutersStrict(crud, custom)` that throws on duplicate handles.
- Changes: `BuildApiRegistryOptions.foreignSpecs` to `Array<{ spec: Record<string, unknown>; prefix?: string; source: string }>` so normalization is explicit and testable.
- Guarantees: no path, handle, operationId, or unequal component can be silently renamed or overwritten.

- [ ] **Step 1: Add a failing same-handle/different-path test**

Declare custom `posts.list` at `/api/archive-posts` while generated CRUD already owns `posts.list`. Assert `createBunderstack()` rejects with both handle and paths in the error. This specifically proves that `__collision` renaming is gone.

- [ ] **Step 2: Add a failing post-prefix auth collision test**

Use a native operation at `/api/auth/sign-in/email` and a foreign spec containing `/sign-in/email`. Assert registry construction rejects after applying the auth prefix:

```ts
await expect(
  buildApiRegistry({
    nativeRouter,
    foreignSpecs: [{ spec: authSpec, prefix: '/api/auth' }],
  }),
).rejects.toThrow(/POST \/api\/auth\/sign-in\/email/)
```

- [ ] **Step 3: Add duplicate operationId and merge-overwrite tests**

Cover all of these cases independently:

- two native procedures with distinct handles but the same explicit operationId;
- native and auth operations resolving to the same method/path after prefixing;
- an auth path colliding with an existing native path during `mergeOpenAPISpecs`;
- equal duplicate components accepted, unequal duplicate components rejected.

The path merge test must assert an exception rather than which operation wins.

- [ ] **Step 4: Verify focused failures**

Run:

```bash
bun test --cwd packages/bunderstack src/api/registry.test.ts src/api/openapi.test.ts
```

Expected: failures demonstrating handle renaming, pre-prefix validation, and silent path overwrite.

- [ ] **Step 5: Replace permissive router merge**

Move router composition out of `index.ts` and use strict recursive semantics:

```ts
export function mergeApiRoutersStrict(
  target: Record<string, unknown>,
  source?: Record<string, unknown>,
  prefix: string[] = [],
): Record<string, unknown> {
  // recurse only when both values are router namespaces
  // throw immediately when either overlapping value is a procedure/leaf
}
```

The thrown error must contain the dotted handle, for example `posts.list`.

- [ ] **Step 6: Canonicalize foreign specs before validation and merge**

Rewrite Better Auth paths exactly once, returning a cloned spec. Feed that same normalized spec to both `buildApiRegistry` and `mergeOpenAPISpecs`; do not let each consumer independently add prefixes.

- [ ] **Step 7: Respect real operation IDs**

When native metadata exposes an operationId, record it; otherwise use the dotted handle. Keep `handle` and `operationId` as independent registry fields. For foreign operations use `foreign:<source>:<METHOD>:<normalized-path>` as the handle and retain the document's `operationId` separately, so duplicate-handle and duplicate-operationId checks are not aliases of the same comparison.

- [ ] **Step 8: Reject path overwrites in OpenAPI merge**

For every target path and HTTP method, compare existing and incoming operations. Throw when both exist unless they are structurally equal. Preserve non-operation Path Item fields such as `parameters`; do not replace the whole Path Item object.

- [ ] **Step 9: Run focused and route regression tests**

Run:

```bash
bun test --cwd packages/bunderstack src/api/registry.test.ts src/api/openapi.test.ts src/routes.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: all collisions fail during application construction and valid auth/native specs still merge.

- [ ] **Step 10: Commit**

```bash
git add packages/bunderstack/src/api/registry.ts packages/bunderstack/src/api/openapi.ts packages/bunderstack/src/index.ts packages/bunderstack/src/api/registry.test.ts packages/bunderstack/src/api/openapi.test.ts
git commit -m "fix(api): reject canonical route and spec collisions"
```

---

### Task 5: Extract one transport-neutral CRUD execution core

**Files:**

- Create: `packages/bunderstack/src/crud-operations.ts`
- Create: `packages/bunderstack/src/crud-operations.test.ts`
- Modify: `packages/bunderstack/src/crud.ts`
- Modify: `packages/bunderstack/src/api/crud-router.ts`
- Test: `packages/bunderstack/src/crud.test.ts`
- Test: `packages/bunderstack/src/api/crud-router.test.ts`
- Test: `packages/bunderstack/src/crud-scope.test.ts`
- Test: `packages/bunderstack/src/crud-broadcast.test.ts`

**Interfaces:**

- Produces: `createCrudOperations(deps)` with `list`, `get`, `create`, `update`, and `delete` methods.
- Produces: `CrudOperationError` carrying canonical `status`, Bunderstack `code`, `message`, and optional `details`.
- Consumes: parsed input plus `CrudExecutionContext { request, user, session }`.
- Leaves: HTTP parsing/serialization in Hono and oRPC adapters only.

- [ ] **Step 1: Add adapter-parity tests before extraction**

For both Hono and oRPC transports, exercise the same fixtures and assert equality of:

- list/get/create/update/delete success payloads;
- `201` create and `204` delete;
- unauthenticated and forbidden statuses and error codes;
- read/write scope hiding and stamping;
- invalid input behavior;
- idempotency conflict and replay status/body/`Idempotency-Replayed` header;
- exactly one realtime publication for create/update/delete.

Use a small helper that sends the same semantic operation through both transports; do not duplicate assertions into unrelated test bodies.

- [ ] **Step 2: Run parity tests and record current divergences**

Run:

```bash
bun test --cwd packages/bunderstack src/crud.test.ts src/api/crud-router.test.ts src/crud-scope.test.ts src/crud-broadcast.test.ts
```

Expected: new parity assertions expose any differences currently hidden by the spike tests. Preserve the established Hono wire contract when deciding the expected result.

- [ ] **Step 3: Define the shared execution contracts**

Create explicit request-independent inputs:

```ts
export interface CrudExecutionContext {
  request: Request
  user: AccessUser | null
  session: { activeOrganizationId: string | null }
}

export class CrudOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
```

Define operation results explicitly, including idempotency replay metadata; do not encode HTTP `Response` objects in the core.

- [ ] **Step 4: Move list/get logic into the shared core**

Move access enforcement, scope construction, row visibility, ID coercion, `parseListParams`, and `executeList` calls into `createCrudOperations`. Make both adapters parse their transport input and delegate. Run list/get-focused tests after the move.

- [ ] **Step 5: Move create/update/delete logic into the shared core**

Move sanitization, ownership stamping, write scopes, idempotency lookup/storage, database writes, and realtime publication. Preserve raw-body hashing semantics for Hono and define the oRPC adapter's canonical raw body consistently.

- [ ] **Step 6: Map canonical errors in each adapter**

The Hono adapter must continue using the existing Bunderstack error envelope. Configure the oRPC OpenAPI error mapping so its REST response has the same status and JSON envelope; merely returning oRPC's default error body is not sufficient. RPC transport may retain oRPC's protocol envelope, but must carry the same canonical Bunderstack error code in its error data.

- [ ] **Step 7: Prove there is one behavior implementation**

After extraction, `crud.ts` and `api/crud-router.ts` may contain route definitions, schema declarations, parsing, response/header mapping, and calls to `operations.*`. They must not contain direct Drizzle CRUD queries, access checks, scope stamping, idempotency persistence, or realtime publication.

Add a short source-boundary assertion if necessary to prevent these imports from returning to the adapters.

- [ ] **Step 8: Run CRUD verification**

Run:

```bash
bun test --cwd packages/bunderstack src/crud-operations.test.ts src/crud.test.ts src/crud.pg.test.ts src/crud-scope.test.ts src/crud-broadcast.test.ts src/api/crud-router.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: parity and existing CRUD tests pass with one implementation of business behavior.

- [ ] **Step 9: Commit**

```bash
git add packages/bunderstack/src/crud-operations.ts packages/bunderstack/src/crud-operations.test.ts packages/bunderstack/src/crud.ts packages/bunderstack/src/api/crud-router.ts packages/bunderstack/src/crud.test.ts packages/bunderstack/src/api/crud-router.test.ts packages/bunderstack/src/crud-scope.test.ts packages/bunderstack/src/crud-broadcast.test.ts
git commit -m "refactor(crud): share execution across hono and orpc"
```

---

### Task 6: Make OpenAPI generation reproducible and update the examples

**Files:**

- Create: `packages/bunderstack/src/api/openapi-client-generation.test.ts`
- Modify: `examples/todo/src/bunderstack.ts`
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Modify: `docs/plans/2026-08-09-unified-orpc-api-findings.md`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Proves: the combined OpenAPI 3.1 document contains typed CRUD, custom, and Better Auth operations.
- Proves: `openapi-typescript 7.13.0` can generate and TypeScript can compile a temporary client.
- Proves: representative examples need no explicit `any` annotations in API declarations or `client.api` calls.

- [ ] **Step 1: Remove API-related type escapes from both examples**

Change declarations to rely on inference:

```ts
api: (o) => ({
  feed: o.public
    .input(feedInputSchema)
    .output(feedOutputSchema)
    .handler(async ({ context, input }) => {
      // context and input inferred
    }),
})
```

Remove explicit `{ context: any; input: any }`, `(client.api as any)`, and equivalent casts associated with the new API. Keep unrelated legacy casts out of scope.

- [ ] **Step 2: Add a generated-client test with a temporary directory**

First pin the generator in the workspace so the test never relies on an implicit download:

```bash
bun add -d openapi-typescript@7.13.0
```

The test must:

1. Construct a fixture app with CRUD, one custom procedure, and Better Auth.
2. request `/api/openapi.json` through `app.handler`;
3. write the spec under `mkdtemp()`/`Bun.write()`;
4. run the pinned local `openapi-typescript` executable;
5. compile a small consumer that references a CRUD request body, custom response, and auth operation;
6. remove the temporary directory in `finally`;
7. leave no generated file in the repository.

- [ ] **Step 3: Verify concrete CRUD schemas in the generated contract**

Assert that:

- create requires the table's required insert fields;
- update fields retain their Drizzle/Zod scalar types;
- select responses expose real table columns;
- disabled tables are absent;
- custom procedure inputs/outputs are present;
- Better Auth paths are under `/api/auth/*` exactly once.

- [ ] **Step 4: Add a deterministic root verification script**

Add a script such as:

```json
{
  "test:orpc-contract": "bun test packages/bunderstack/src/api/openapi-client-generation.test.ts && bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json"
}
```

Use the repository's pinned executable resolution; the test must not download packages from the network.

- [ ] **Step 5: Run example and contract verification**

Run:

```bash
bun run test:orpc-contract
bun run typecheck:examples
bun run typecheck:all
```

Expected: all commands pass without API-related `any` annotations.

- [ ] **Step 6: Correct the findings document**

Replace the unconditional verdict with evidence from this hardening pass. The final `GO / ADOPT` is allowed only if all of these are true:

- invalid client calls fail compile-time tests;
- custom and generated CRUD procedures retain input/output types through `createClient<typeof app>()`;
- collision tests fail at application construction after canonical path rewriting;
- both transports use one CRUD execution core;
- generated OpenAPI client compilation is automated and reproducible;
- all regression, boundary, bundle, and example checks pass.

Record exact command results rather than estimated test counts, dependency size, or timing claims.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/api/openapi-client-generation.test.ts examples/todo/src/bunderstack.ts examples/twitter-tanstack/src/bunderstack.ts docs/plans/2026-08-09-unified-orpc-api-findings.md package.json bun.lock
git commit -m "test(api): verify typed openapi and example ergonomics"
```

---

### Task 7: Final regression gate and honest adoption decision

**Files:**

- Modify only if evidence requires correction: `docs/plans/2026-08-09-unified-orpc-api-findings.md`

**Interfaces:**

- Produces: a reproducible final `GO`, `CONDITIONAL GO`, or `NO-GO` decision.
- Produces: a clean worktree with no generated clients, databases, or unrelated changes.

- [ ] **Step 1: Run the complete verification suite from a clean state**

Run:

```bash
bun run test
bun run typecheck:all
bun run test:boundaries
bun run test:bundles
bun run test:orpc-contract
git status --short
```

Expected: all commands pass and `git status --short` lists only intentional documentation changes, if any.

- [ ] **Step 2: Audit the public type surface for forbidden escapes**

Run:

```bash
rg -n "api: any|client\.api as any|createORPCClient<any>|TableCrudProcedures = \{|api\?: \(o: any\)" packages examples
```

Expected: no matches in the unified API implementation, tests, or migrated examples.

- [ ] **Step 3: Audit adapter responsibilities**

Inspect `crud.ts` and `api/crud-router.ts`. Confirm both are transport adapters over `crud-operations.ts` and neither contains independently maintained authorization, scoping, persistence, idempotency, or realtime behavior.

- [ ] **Step 4: Update the findings with exact evidence**

Include command names, pass/fail results, any remaining beta-version risk, and the final verdict. Do not call the API “100% type-safe” unless the negative compile-time tests from Task 3 pass.

- [ ] **Step 5: Commit the final evidence if it changed**

```bash
git add docs/plans/2026-08-09-unified-orpc-api-findings.md
git commit -m "docs: finalize unified orpc hardening verdict"
```

## Acceptance Checklist

- [ ] `api: (o) => ...` contextually infers the builder, input, public context, protected user/session, database, and env.
- [ ] `createClient<typeof app>().api` exposes only real custom and enabled CRUD handles.
- [ ] Invalid handles and invalid inputs fail compile-time tests without casts.
- [ ] CRUD create/update/select schemas are derived from Drizzle and remain concrete in OpenAPI.
- [ ] Duplicate handles never receive a synthetic `__collision` suffix.
- [ ] Auth paths are canonicalized before registry validation and OpenAPI merge.
- [ ] No method/path or component can be silently overwritten.
- [ ] Hono and oRPC call one shared CRUD execution core.
- [ ] Existing URLs, statuses, payloads, access, scoping, idempotency, and realtime behavior are preserved.
- [ ] OpenAPI client generation and compilation are reproducible without network access or committed generated files.
- [ ] Full tests, all typechecks, boundary tests, bundle tests, and example checks pass.
