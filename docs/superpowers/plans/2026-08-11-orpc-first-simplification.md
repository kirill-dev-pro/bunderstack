# oRPC-First Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bunderstack's parallel Hono, tRPC, REST-client, and custom-realtime layers with one Standard-Schema-driven oRPC graph covering CRUD, custom procedures, webhooks, storage, and realtime.

**Architecture:** `createBunderstack` builds transport-neutral operations and adapts them once into a single oRPC router. A Web Standard dispatcher reserves Better Auth, delegates `/api/rpc/*` to `RPCHandler`, delegates routed HTTP procedures to `OpenAPIHandler`, and otherwise returns 404. The same router type drives the direct client and TanStack Query helpers. Realtime is an oRPC Event Iterator backed by `@orpc/publisher`; storage procedures wrap a transport-neutral `StorageOperations` object.

**Tech Stack:** Bun 1.3.x, TypeScript 5.8+, oRPC `2.0.0-beta.26`, `@orpc/publisher` and `@orpc/bun` `2.0.0-beta.26`, Valibot 1.4.2, Standard Schema 1.1.0, Drizzle ORM 0.45.x, Better Auth, TanStack Query 5.

## Global Constraints

- This is an intentionally breaking beta migration. Do not add compatibility aliases for Hono routes, tRPC, `/files/*`, `app.router`, split clients, `clientId`, or realtime `gap` state.
- Pin every oRPC package, including `@orpc/publisher`, `@orpc/bun`, and `@orpc/valibot`, to `2.0.0-beta.26`.
- Public validation slots accept `StandardSchemaV1`; internal/generated schemas use Valibot.
- Handler return inference is the normal output contract. Add `.output(...)` only to built-ins that need runtime output validation, streaming, binary/detailed output, or exact OpenAPI.
- Preserve access, scope, idempotency, quota, transform, cleanup, and cache-correctness behavior. Delete transport-specific duplication.
- Every behavior-changing task starts with a failing test and ends with the narrowest relevant passing tests. Run package typecheck at the integration checkpoints in Tasks 8–15, after each temporarily incompatible package-wide migration is complete.
- Do not run formatter over unrelated files. Preserve existing user changes.
- The final production-source diff must be net-negative in both files and lines. Test and plan files do not count toward this metric.

## File and Interface Map

| Producer | Interface produced | Consumers |
|---|---|---|
| `packages/bunderstack/src/standard-schema.ts` | synchronous `validateStandardSchema`, `InferStandardOutput` | env, jobs, manifest/config validation |
| `packages/bunderstack/src/errors.ts` | `BunderstackError`, declared oRPC error map, mapping middleware | CRUD, storage, realtime, custom bases |
| `packages/bunderstack/src/api/builder.ts` | `public`, `protected`, `webhook` procedure bases | generated and application procedures |
| `packages/bunderstack/src/crud-operations.ts` | transport-neutral CRUD behavior | `api/crud-router.ts` only |
| `packages/bunderstack/src/storage/operations.ts` | `StorageOperations` | `api/storage-router.ts`, server storage facade |
| `packages/bunderstack/src/realtime/publisher.ts` | typed `RealtimePublisher` factory | CRUD writes, application facade, realtime procedure |
| `packages/bunderstack/src/api/router.ts` | merged `AppRouter` | dispatcher, server app type, query client |
| `packages/bunderstack/src/handler.ts` | `(Request) => Promise<Response>` dispatcher | framework adapters and examples |
| `packages/bunderstack-query/src/client.ts` | unified oRPC/TanStack client | examples and `bunderstack-sync` |

---

### Task 1: Add Standard Schema validation without changing transport versions

**Files:**

- Modify: `packages/bunderstack/package.json`
- Create: `packages/bunderstack/src/standard-schema.ts`
- Create: `packages/bunderstack/src/standard-schema.test.ts`
- Modify: `packages/bunderstack/src/env.ts`
- Modify: `packages/bunderstack/src/env.test.ts`
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/define.test.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`
- Modify: `packages/bunderstack/src/jobs/jobs.pg.test.ts`
- Modify: `packages/bunderstack/src/jobs/queue.test.ts`
- Modify: `packages/bunderstack/src/jobs/worker.test.ts`
- Modify: `packages/bunderstack/src/manifest.ts`
- Modify: `packages/bunderstack/src/manifest.test.ts`
- Modify: `packages/bunderstack/src/blueprint.ts`
- Modify: `packages/bunderstack/src/blueprint.test.ts`

- [ ] **Step 1: Write failing Standard Schema tests**

Cover successful Valibot parsing, transformed output, normalized issues, and explicit rejection of asynchronous validation from synchronous boot paths:

```ts
expect(() => validateStandardSchema(asyncSchema, value, 'env')).toThrow(
  '[bunderstack] env schema validation must be synchronous',
)
```

Run: `bun test packages/bunderstack/src/standard-schema.test.ts`

Expected: FAIL because `standard-schema.ts` does not exist.

- [ ] **Step 2: Implement the shared synchronous validator**

Use `StandardSchemaV1` from `@standard-schema/spec` and call `schema['~standard'].validate(value)`. If the result is promise-like, throw the synchronous-boundary error. If it contains issues, throw an exported `StandardSchemaValidationError` with normalized path/message details; Task 2 maps that error into the shared procedure error. Export the inferred output helper from the same file.

- [ ] **Step 3: Replace direct Zod contracts in boot-time validation**

Change env extension schemas and job payload schemas to `StandardSchemaV1`. Replace `.parse`/`.safeParse` in env, jobs, manifest, and blueprint call sites with `validateStandardSchema` or equivalent Valibot schemas. Convert every job/env/manifest/blueprint fixture from Zod to Valibot so Zod is not retained as a test-only dependency. Keep these paths synchronous; job execution may accept transformed synchronous output.

- [ ] **Step 4: Add the validation dependencies**

Add these exact dependencies to `packages/bunderstack/package.json`:

```json
"@standard-schema/spec": "1.1.0",
"valibot": "1.4.2"
```

Keep the existing oRPC beta pins and legacy transport dependencies unchanged in this task so unrelated modules remain loadable. Publisher and the Valibot converter join the same beta family in Tasks 5 and 7. Zod is removed in Task 13 after Tasks 8, 12, and 13 migrate the remaining fixtures.

Run: `bun install`

Expected: lockfile adds Standard Schema and Valibot without changing the existing oRPC pins.

- [ ] **Step 5: Verify the foundation**

Run: `bun test packages/bunderstack/src/standard-schema.test.ts packages/bunderstack/src/env.test.ts packages/bunderstack/src/jobs/define.test.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/jobs/jobs.pg.test.ts packages/bunderstack/src/jobs/queue.test.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bun.lock packages/bunderstack/package.json packages/bunderstack/src/standard-schema.ts packages/bunderstack/src/standard-schema.test.ts packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts packages/bunderstack/src/jobs packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts
git commit -m "refactor: adopt standard schema validation"
```

### Task 2: Establish the unified error model and semantic procedure bases

**Files:**

- Modify: `packages/bunderstack/src/errors.ts`
- Create: `packages/bunderstack/src/errors.test.ts`
- Modify: `packages/bunderstack/src/api/builder.ts`
- Modify: `packages/bunderstack/src/api/builder.test.ts`
- Modify: `packages/bunderstack/src/api/context.ts`
- Create: `packages/bunderstack/src/api/context.test.ts`
- Modify: `packages/bunderstack/src/api/types.ts`

- [ ] **Step 1: Write failing typed-error and context tests**

Assert one internal error maps to each public code/status and preserves `data.code` plus optional `data.details`. Assert `public` and `webhook` never call the auth resolver, `protected` calls it once and narrows `context.user`, and two `getRawBody()` calls return the exact original bytes.

Run: `bun test packages/bunderstack/src/errors.test.ts packages/bunderstack/src/api/builder.test.ts packages/bunderstack/src/api/context.test.ts`

Expected: FAIL because the common mapping middleware and webhook base are absent.

- [ ] **Step 2: Replace Hono error responses with one transport-neutral error**

Define `BunderstackError` with codes `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, and `RATE_LIMITED`. Convert Task 1's `StandardSchemaValidationError` to `VALIDATION_ERROR`. Export one `BUNDERSTACK_ERRORS` declaration for `os.errors(...)` and one middleware that translates only these known errors; unknown exceptions remain internal.

- [ ] **Step 3: Build semantic bases from the same oRPC primitive**

Construct the base as:

```ts
const base = os
  .$context<ApiContext<TSchema, TEnv>>()
  .errors(BUNDERSTACK_ERRORS)
  .use(mapBunderstackErrors)

return {
  public: base,
  protected: base.use(requireSession),
  webhook: base,
}
```

Keep session and raw-body promises lazy and memoized in `ApiContext`. Preserve the untouched original `Request`; reserve a clone only for raw bytes.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/bunderstack/src/errors.test.ts packages/bunderstack/src/api/builder.test.ts packages/bunderstack/src/api/context.test.ts`

Expected: PASS.

```bash
git add packages/bunderstack/src/errors.ts packages/bunderstack/src/errors.test.ts packages/bunderstack/src/api/builder.ts packages/bunderstack/src/api/builder.test.ts packages/bunderstack/src/api/context.ts packages/bunderstack/src/api/context.test.ts packages/bunderstack/src/api/types.ts
git commit -m "refactor: unify procedure context and errors"
```

### Task 3: Make generated CRUD the only CRUD transport

**Files:**

- Modify: `packages/bunderstack/src/api/crud-router.ts`
- Modify: `packages/bunderstack/src/api/crud-router.test.ts`
- Modify: `packages/bunderstack/src/api/api-types.types.ts`
- Modify: `packages/bunderstack/src/crud-operations.ts`
- Modify: `packages/bunderstack/src/crud-operations.test.ts`
- Delete: `packages/bunderstack/src/crud.ts`
- Delete: `packages/bunderstack/src/crud.test.ts`
- Delete: `packages/bunderstack/src/crud.pg.test.ts`
- Modify: `packages/bunderstack/src/crud-broadcast.test.ts`
- Modify: `packages/bunderstack/src/crud-scope.test.ts`

- [ ] **Step 1: Add failing Valibot-generated CRUD contract tests**

Assert every exposed table produces `list/get/create/update/delete`, routes map to the canonical `/api/<table>` family, insert/update input rejects unknown or immutable `id` fields, and output types derive from Drizzle tables without public `any`.

Run: `bun test packages/bunderstack/src/api/crud-router.test.ts`

Expected: FAIL while `drizzle-zod`, Zod shapes, and oRPC-2 `openapi(...)` metadata remain.

- [ ] **Step 2: Generate schemas with `drizzle-orm/valibot`**

Use `createSelectSchema` and `createInsertSchema` from `drizzle-orm/valibot`. Compose list/query/update inputs with Valibot. Describe HTTP projection using `.route({ method, path, ... })`; do not use `@orpc/zod` or the old `openapi(...)` metadata helper.

- [ ] **Step 3: Route all operation failures through the shared middleware**

Change `CrudOperationError` to extend or convert once into `BunderstackError`. Remove five per-handler `try/catch` blocks and `toORPCError`. Keep idempotency header and raw-body behavior in the procedure adapter.

- [ ] **Step 4: Delete the Hono CRUD implementation and port behavior tests**

Move any missing access, scope, list/cursor, idempotency, and broadcast assertion into `crud-operations.test.ts` or `api/crud-router.test.ts`, then delete `crud.ts` and its transport-parity suites.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/bunderstack/src/crud-operations.test.ts packages/bunderstack/src/api/crud-router.test.ts packages/bunderstack/src/crud-broadcast.test.ts packages/bunderstack/src/crud-scope.test.ts`

Expected: PASS.

```bash
git add packages/bunderstack/src/api/api-types.types.ts packages/bunderstack/src/api/crud-router.ts packages/bunderstack/src/api/crud-router.test.ts packages/bunderstack/src/crud-operations.ts packages/bunderstack/src/crud-operations.test.ts packages/bunderstack/src/crud-broadcast.test.ts packages/bunderstack/src/crud-scope.test.ts packages/bunderstack/src/crud.ts packages/bunderstack/src/crud.test.ts packages/bunderstack/src/crud.pg.test.ts
git commit -m "refactor: make oRPC the sole CRUD transport"
```

### Task 4: Extract storage behavior and expose it as generated procedures

**Files:**

- Create: `packages/bunderstack/src/storage/operations.ts`
- Create: `packages/bunderstack/src/storage/operations.test.ts`
- Create: `packages/bunderstack/src/api/storage-router.ts`
- Create: `packages/bunderstack/src/api/storage-router.test.ts`
- Modify: `packages/bunderstack/src/storage/index.ts`
- Modify: `packages/bunderstack/src/storage/buckets.ts`
- Delete: `packages/bunderstack/src/storage/router.ts`
- Delete: `packages/bunderstack/src/storage/router.test.ts`
- Modify: `packages/bunderstack/src/storage/multibucket.integration.test.ts`

- [ ] **Step 1: Freeze storage behavior in operation-level tests**

Port tests for proxy upload, prepare/direct/confirm, MIME and size limits, per-owner/per-scope quotas, access/scope, pending metadata, orphan cleanup, private presign, public redirect, proxy download, transforms, derivative caching, and delete cleanup.

Run: `bun test packages/bunderstack/src/storage/operations.test.ts`

Expected: FAIL because `createStorageOperations` does not exist.

- [ ] **Step 2: Extract `StorageOperations` without Request/Hono types**

Create methods `prepareUpload`, `upload`, `confirmUpload`, `download`, and `delete`. Inputs contain authenticated execution context plus plain data/File values; outputs are domain results describing bytes, redirect URL, content type, size, filename, and status. Reuse existing helpers in `storage/delete.ts`, `storage/file-meta.ts`, `storage/sweep.ts`, and `storage/thumbnails.ts`.

- [ ] **Step 3: Generate bucket routers**

For every configured bucket, generate the five procedures under `files.<bucket>`. Use Valibot inputs and oRPC detailed output for status/headers/redirect or stream responses. The only routed download path is:

```ts
.route({ method: 'GET', path: '/api/files/{bucket}/{+path}' })
```

Do not register `/files/*`.

- [ ] **Step 4: Verify operation and HTTP projection parity**

Run: `bun test packages/bunderstack/src/storage/operations.test.ts packages/bunderstack/src/api/storage-router.test.ts packages/bunderstack/src/storage/multibucket.integration.test.ts`

Expected: PASS for local proxy and presigned backends.

- [ ] **Step 5: Delete the Hono router and commit**

```bash
git add packages/bunderstack/src/storage/operations.ts packages/bunderstack/src/storage/operations.test.ts packages/bunderstack/src/api/storage-router.ts packages/bunderstack/src/api/storage-router.test.ts packages/bunderstack/src/storage/index.ts packages/bunderstack/src/storage/buckets.ts packages/bunderstack/src/storage/router.ts packages/bunderstack/src/storage/router.test.ts packages/bunderstack/src/storage/multibucket.integration.test.ts
git commit -m "refactor: expose storage through oRPC procedures"
```

### Task 5: Replace the realtime broker with oRPC Publisher

**Files:**

- Modify: `packages/bunderstack/package.json`
- Modify: `bun.lock`
- Create: `packages/bunderstack/src/realtime/publisher.ts`
- Create: `packages/bunderstack/src/realtime/publisher.test.ts`
- Create: `packages/bunderstack/src/realtime/publisher.redis.test.ts`
- Modify: `packages/bunderstack/src/realtime/facade.ts`
- Modify: `packages/bunderstack/src/realtime/facade.test.ts`
- Modify: `packages/bunderstack/src/realtime/app-publish.test.ts`
- Delete: `packages/bunderstack/src/realtime/index.ts`
- Delete: `packages/bunderstack/src/realtime/index.test.ts`
- Delete: `packages/bunderstack/src/realtime/redis.ts`
- Delete: `packages/bunderstack/src/realtime/redis.test.ts`
- Delete: `packages/bunderstack/src/realtime/sse.test.ts`

- [ ] **Step 1: Write Publisher contract tests**

Assert typed publish/subscribe, abort cleanup, bounded buffering, `lastEventId` replay, expiry behavior, and facade no-op behavior when realtime is disabled.

Run: `bun test packages/bunderstack/src/realtime/publisher.test.ts`

Expected: FAIL because the publisher factory does not exist.

- [ ] **Step 2: Use `MemoryPublisher` for local realtime**

Add `@orpc/publisher` and `@orpc/bun` at exact version `2.0.0-beta.26`. Instantiate `MemoryPublisher<RealtimeEvents>({ resume: { enabled: true, seconds }, maxBufferedEvents })` locally. `RealtimeEvents.change` contains table, action, and record. Adapt the existing facade to call `publisher.publish('change', event)`; remove broker sequence/gap concepts from its type.

- [ ] **Step 3: Use the official Bun Redis adapter**

Instantiate `BunRedisPublisher<RealtimeEvents>` from `@orpc/bun` with Bun's built-in `redis` client, a duplicated subscriber, a Bunderstack key prefix, and `resume: { enabled: true, seconds }`. Register both clients with the application lifecycle. Bunderstack must not implement Redis Pub/Sub, Streams, IDs, trimming, serialization, replay, or duplicate suppression.

- [ ] **Step 4: Prove cross-instance Redis behavior**

The Redis integration test creates two official `BunRedisPublisher` instances, publishes through one, receives through the other, resumes from an ID, and verifies unsubscribe/close. Gate it with `BUNDERSTACK_TEST_REDIS_URL` using `test.skipIf(!url)`, matching the repository's external-service test pattern; do not maintain a fake implementation of the adapter internals. CI must provide this URL for the final acceptance run.

- [ ] **Step 5: Delete the old broker and commit**

Run: `bun test packages/bunderstack/src/realtime/publisher.test.ts packages/bunderstack/src/realtime/publisher.redis.test.ts packages/bunderstack/src/realtime/facade.test.ts packages/bunderstack/src/realtime/app-publish.test.ts`

Expected: PASS.

```bash
git add packages/bunderstack/package.json bun.lock packages/bunderstack/src/realtime packages/bunderstack/src/crud-broadcast.test.ts
git commit -m "refactor: replace realtime broker with oRPC Publisher"
```

### Task 6: Extract transport-neutral realtime access filtering

**Files:**

- Create: `packages/bunderstack/src/realtime/filter.ts`
- Create: `packages/bunderstack/src/realtime/filter.test.ts`
- Modify: `packages/bunderstack/src/access.ts`
- Modify: `packages/bunderstack/src/access.integration.test.ts`
- Modify: `packages/bunderstack/src/scope.ts`

- [ ] **Step 1: Write failing async-iterable filtering tests**

Cover requested-table filtering, anonymous/authenticated access, table access rules, organization scope, record-level predicates, abort cleanup, replay through `lastEventId`, and no procedure when realtime is disabled.

Run: `bun test packages/bunderstack/src/realtime/filter.test.ts`

Expected: FAIL because `filterRealtimeChanges` does not exist.

- [ ] **Step 2: Implement the filtering generator**

Accept an `AsyncIterable<RealtimeEvents['change']>`, requested tables, resolved access, and a lazy session resolver. Yield only visible table/record events. Resolve the session only when access rules require it. When projecting a payload, preserve its Publisher ID with `getEventMeta`/`withEventMeta`; otherwise client reconnection cannot advance `lastEventId`. This module does not own transport, retention, or replay.

- [ ] **Step 3: Verify and commit**

Run: `bun test packages/bunderstack/src/realtime/filter.test.ts packages/bunderstack/src/access.integration.test.ts`

Expected: PASS.

```bash
git add packages/bunderstack/src/realtime/filter.ts packages/bunderstack/src/realtime/filter.test.ts packages/bunderstack/src/access.ts packages/bunderstack/src/access.integration.test.ts packages/bunderstack/src/scope.ts
git commit -m "refactor: isolate realtime access filtering"
```

### Task 7: Build one router registry and Web Standard dispatcher

**Files:**

- Modify: `bun.lock`
- Modify: `packages/bunderstack/package.json`
- Modify: `packages/bunderstack-query/package.json`
- Modify: `examples/todo/package.json`
- Modify: `examples/twitter-tanstack/package.json`
- Create: `packages/bunderstack/src/api/realtime-router.ts`
- Create: `packages/bunderstack/src/api/realtime-router.test.ts`
- Create: `packages/bunderstack/src/api/router.ts`
- Create: `packages/bunderstack/src/api/router.test.ts`
- Modify: `packages/bunderstack/src/api/registry.ts`
- Modify: `packages/bunderstack/src/api/registry.test.ts`
- Modify: `packages/bunderstack/src/api/openapi.ts`
- Modify: `packages/bunderstack/src/api/openapi.test.ts`
- Modify: `packages/bunderstack/src/handler.ts`
- Create: `packages/bunderstack/src/handler.test.ts`
- Modify: `packages/bunderstack/src/rate-limit.test.ts`
- Delete: `packages/bunderstack/src/routes.ts`
- Delete: `packages/bunderstack/src/routes.test.ts`
- Delete: `packages/bunderstack/src/routes-integration.test.ts`

- [ ] **Step 1: Write failing graph and dispatch tests**

Assert generated health/CRUD/files/realtime and custom procedures share one graph; duplicate names and HTTP routes fail at construction; `/api/auth/*` is reserved; rate limiting runs first; `/api/rpc/*` uses `RPCHandler`; routed HTTP uses `OpenAPIHandler`; unmatched requests return 404. The realtime integration test returns an async generator directly from the v2 handler, passes `signal` and `lastEventId` into `publisher.subscribe('change', { signal, lastEventId })`, and applies Task 6's metadata-preserving filter before yielding.

Add a webhook test that sends non-normalized JSON bytes, verifies the provider signature against `context.getRawBody()`, reads a header, and proves auth resolution count remains zero.

Run: `bun test packages/bunderstack/src/api/realtime-router.test.ts packages/bunderstack/src/api/router.test.ts packages/bunderstack/src/handler.test.ts`

Expected: FAIL because the graph builder and non-Hono dispatcher do not exist.

- [ ] **Step 2: Complete and verify the oRPC v2 beta family**

Pin every directly consumed oRPC package to the compatible family:

```json
"@orpc/bun": "2.0.0-beta.26",
"@orpc/client": "2.0.0-beta.26",
"@orpc/openapi": "2.0.0-beta.26",
"@orpc/publisher": "2.0.0-beta.26",
"@orpc/server": "2.0.0-beta.26",
"@orpc/tanstack-query": "2.0.0-beta.26",
"@orpc/valibot": "2.0.0-beta.26"
```

Remove `@orpc/zod`, add the Valibot converter, and run `bun install`. Keep the existing v2 server/client/OpenAPI code; this task does not downgrade or rewrite it to v1 APIs.

- [ ] **Step 3: Merge one router with strict collision checks**

Create one typed router object containing `health`, table routers, `files`, optional `realtime`, and custom procedures. Validate namespace and route collisions before constructing handlers. Remove `routes:` and `RouteContext`; application HTTP endpoints use `.route(...)`.

- [ ] **Step 4: Implement the dispatcher**

Create `RPCHandler` from `@orpc/server/fetch` and `OpenAPIHandler` from `@orpc/openapi/fetch`. Dispatch in this exact order: rate limit, Better Auth prefix, RPC prefix, routed HTTP handler, 404. For both oRPC handlers, construct the same `ApiContext` from the original request and propagate `resHeaders`.

- [ ] **Step 5: Make OpenAPI opt-in**

Use `ValibotToJsonSchemaConverter` from `@orpc/valibot`. Normal app construction must not call the generator. When enabled, expose `/api/openapi.json`; a custom unsupported schema reports its procedure path only when generating the document. Procedures without `.output()` remain operational and have an unspecified response body.

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/bunderstack/src/api/realtime-router.test.ts packages/bunderstack/src/api/router.test.ts packages/bunderstack/src/api/registry.test.ts packages/bunderstack/src/api/openapi.test.ts packages/bunderstack/src/handler.test.ts packages/bunderstack/src/rate-limit.test.ts`

Expected: PASS.

Run: `bun pm ls | rg '@orpc/(bun|client|server|openapi|publisher|tanstack-query|valibot)'`

Expected: all direct versions are `2.0.0-beta.26`; no direct oRPC 1.x entry.

```bash
git add bun.lock packages/bunderstack/package.json packages/bunderstack-query/package.json examples/todo/package.json examples/twitter-tanstack/package.json packages/bunderstack/src/api packages/bunderstack/src/handler.ts packages/bunderstack/src/handler.test.ts packages/bunderstack/src/rate-limit.test.ts packages/bunderstack/src/routes.ts packages/bunderstack/src/routes.test.ts packages/bunderstack/src/routes-integration.test.ts
git commit -m "refactor: dispatch one oRPC procedure graph"
```

### Task 8: Simplify `createBunderstack` and remove Hono/tRPC

**Files:**

- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/index.test.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/config.test.ts`
- Modify: `packages/bunderstack/src/app-env.test.ts`
- Modify: `packages/bunderstack/src/infer-client.test.ts`
- Delete: `packages/bunderstack/src/trpc.ts`
- Delete: `packages/bunderstack/src/trpc.test.ts`
- Delete: `packages/bunderstack/src/trpc-mount.test.ts`
- Modify: `packages/bunderstack/package.json`

- [ ] **Step 1: Write the new app-surface type tests**

Assert `createBunderstack({ api: (o) => ({ ... }) })` infers one router with CRUD, files, realtime, and custom outputs. Add negative type assertions for removed `routes`, `trpc`, `router`, and `trpcRouter` fields.

Run: `bun test packages/bunderstack/src/infer-client.test.ts packages/bunderstack/src/index.test.ts`

Expected: FAIL while overloads and `$inferClient` contain split tRPC/API carriers.

- [ ] **Step 2: Collapse the construction path**

Remove the four tRPC × jobs overloads. Retain contextual typing for `api` and `jobs` with one overload plus one implementation. Convert the remaining config and app-env schemas/fixtures from Zod to Valibot. Construct storage operations, publisher, generated routers, custom router, handlers, and lifecycle in one direction. `BunderstackApp` exposes `handler`, an `$inferClient.api` type-only carrier, domain facades, worker methods, and lifecycle state; it does not expose a general router runtime.

- [ ] **Step 3: Remove obsolete dependencies and exports**

Delete package export `./trpc`. Remove direct/peer dependencies and keywords for `hono`, all `@trpc/*`, `zod`, `drizzle-zod`, and `@orpc/zod`. Update the package description to say oRPC and Standard Schema.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/bunderstack/src/index.test.ts packages/bunderstack/src/config.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/infer-client.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json`

Expected: PASS.

```bash
git add packages/bunderstack/src/index.ts packages/bunderstack/src/index.test.ts packages/bunderstack/src/config.ts packages/bunderstack/src/config.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/infer-client.test.ts packages/bunderstack/src/trpc.ts packages/bunderstack/src/trpc.test.ts packages/bunderstack/src/trpc-mount.test.ts packages/bunderstack/package.json bun.lock
git commit -m "refactor: simplify bunderstack around one router"
```

### Task 9: Replace split browser clients with one typed oRPC client

**Files:**

- Modify: `packages/bunderstack-query/src/client.ts`
- Modify: `packages/bunderstack-query/src/api.ts`
- Modify: `packages/bunderstack-query/src/infer.ts`
- Modify: `packages/bunderstack-query/src/types.ts`
- Modify: `packages/bunderstack-query/src/index.ts`
- Modify: `packages/bunderstack-query/src/entrypoints.test.ts`
- Create: `packages/bunderstack-query/src/client.test.ts`
- Delete: `packages/bunderstack-query/src/table-client.ts`
- Delete: `packages/bunderstack-query/src/bucket-client.ts`
- Delete: `packages/bunderstack-query/src/mutation-options.ts`
- Delete: `packages/bunderstack-query/src/trpc.ts`
- Modify: `packages/bunderstack-query/package.json`

- [ ] **Step 1: Write failing unified-client type and runtime tests**

Prove these calls compile and hit the oRPC link: `api.todos.list.queryOptions`, `api.todos.create.mutationOptions`, `api.stats.queryOptions`, and direct `.call`. Prove `api.files.images.url(...)` is a pure helper and upload performs proxy or prepare/direct/confirm without exposing backend selection.

Run: `bun test packages/bunderstack-query/src/client.test.ts packages/bunderstack-query/src/entrypoints.test.ts`

Expected: FAIL because the current client exposes root REST tables, nested `api.api`, and a separate bucket proxy.

- [ ] **Step 2: Build one oRPC link and TanStack utility tree**

Create one `RPCLink` pointed at `/api/rpc`, one router client, and one `createTanstackQueryUtils` tree. Attach only pure file URL helpers to matching bucket namespaces. Do not add alternate fetch transports or casts that erase the inferred router.

- [ ] **Step 3: Delete legacy clients and dependencies**

Remove table/bucket/mutation/tRPC modules and exports. Remove all `@trpc/*`, Zod, SuperJSON, and `@orpc/openapi` client dependencies that are no longer imported.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/bunderstack-query`

Expected: PASS.

Run: `bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json`

Expected: PASS.

```bash
git add packages/bunderstack-query packages/bunderstack-query/package.json bun.lock
git commit -m "refactor: expose one oRPC query client"
```

### Task 10: Integrate realtime cache recovery into the unified client

**Files:**

- Create: `packages/bunderstack-query/src/realtime.ts`
- Create: `packages/bunderstack-query/src/realtime.test.ts`
- Delete: `packages/bunderstack-query/src/realtime-client.ts`
- Delete: `packages/bunderstack-query/src/realtime-client.test.ts`
- Modify: `packages/bunderstack-query/src/client.ts`
- Modify: `packages/bunderstack-query/src/react.tsx`

- [ ] **Step 1: Write failing cache-sync tests**

Use a fake typed async iterator to prove create/update/delete events patch the expected table query keys, reconnect invalidates every subscribed table after establishment, abort cleans up iteration, and expired replay needs no public `gap` state because invalidation refetches canonical data.

Run: `bun test packages/bunderstack-query/src/realtime.test.ts`

Expected: FAIL because the client still owns manual SSE, visibility, watchdog, and reconnect protocol.

- [ ] **Step 2: Consume the generated streaming procedure**

Iterate `client.realtime.changes.call({ tables }, { signal, lastEventId })` through oRPC. Keep only cache patching, reconnect/backoff coordination, and table invalidation. Let oRPC transport and Publisher own SSE decoding, event IDs, replay, and cancellation.

- [ ] **Step 3: Delete the old transport and verify**

Run: `bun test packages/bunderstack-query/src/realtime.test.ts packages/bunderstack-query/src/client.test.ts`

Expected: PASS with no exported `createRealtimeClient`, `clientId`, or `gap`.

```bash
git add packages/bunderstack-query/src/realtime.ts packages/bunderstack-query/src/realtime.test.ts packages/bunderstack-query/src/realtime-client.ts packages/bunderstack-query/src/realtime-client.test.ts packages/bunderstack-query/src/client.ts packages/bunderstack-query/src/react.tsx
git commit -m "refactor: sync query cache from oRPC realtime"
```

### Task 11: Move `bunderstack-sync` onto the unified client

**Files:**

- Modify: `packages/bunderstack-sync/src/realtime-sync.ts`
- Modify: `packages/bunderstack-sync/src/realtime-sync.test.ts`
- Modify: `packages/bunderstack-sync/src/sync-client.ts`
- Modify: `packages/bunderstack-sync/src/sync-client.test.ts`
- Modify: `packages/bunderstack-sync/src/dependency-compatibility.test.ts`
- Modify: `packages/bunderstack-sync/package.json`

- [ ] **Step 1: Rewrite tests against the typed subscription source**

Replace fake `createRealtimeClient` callbacks with an injected async iterable from `api.realtime.changes`. Preserve collection inserts/updates/deletes, scoped collections, optimistic reconciliation, cancellation, and error recovery.

Run: `bun test packages/bunderstack-sync/src/realtime-sync.test.ts packages/bunderstack-sync/src/sync-client.test.ts`

Expected: FAIL until the sync adapter accepts the unified client.

- [ ] **Step 2: Implement the thin sync adapter**

Consume the unified client type from `bunderstack-query`; do not recreate networking or cache keys. Remove SSE terminology from package metadata.

- [ ] **Step 3: Verify and commit**

Run: `bun test packages/bunderstack-sync`

Expected: PASS.

Run: `bunx tsc --noEmit -p packages/bunderstack-sync/tsconfig.json`

Expected: PASS.

```bash
git add packages/bunderstack-sync
git commit -m "refactor: sync collections through oRPC realtime"
```

### Task 12: Migrate representative examples and webhook usage

**Files:**

- Modify: `examples/todo/src/bunderstack.ts`
- Modify: `examples/todo/src/api-client.ts`
- Modify: `examples/todo/src/routes/api/$.tsx`
- Modify: `examples/todo/src/routes/b.$boardId.tsx`
- Modify: `examples/todo/package.json`
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Modify: `examples/twitter-tanstack/src/api-client.ts`
- Modify: `examples/twitter-tanstack/src/hooks/use-feed.ts`
- Modify: `examples/twitter-tanstack/src/routes/api/$.tsx`
- Modify: `examples/twitter-tanstack/package.json`
- Modify: `examples/README.md`
- Modify: `examples/kanban-solid-1.9/src/lib/realtime.ts`
- Modify: `examples/kanban-tanstack/README.md`
- Modify: `examples/kanban-tanstack/package.json`
- Modify: `examples/kanban-tanstack/src/lib/files.ts`
- Modify: `examples/kanban-tanstack/src/lib/realtime.ts`
- Modify: `examples/tldraw/package.json`
- Modify: `examples/tldraw/src/bunderstack.ts`
- Modify: `examples/todo/README.md`
- Modify: `examples/todo/src/router.tsx`
- Modify: `examples/todo/src/routes/index.tsx`
- Modify: `examples/twitter-db-tanstack/package.json`
- Modify: `examples/twitter-db-tanstack/scripts/seed.ts`
- Modify: `examples/twitter-db-tanstack/src/bunderstack.ts`
- Modify: `examples/twitter-db-tanstack/src/components/ImageUpload.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/UserAvatar.tsx`
- Modify: `examples/twitter-tanstack/scripts/seed.ts`
- Modify: `examples/twitter-tanstack/src/components/ImageUpload.tsx`
- Modify: `examples/twitter-tanstack/src/components/UserAvatar.tsx`
- Modify: `templates/tanstack-start-saas/package.json`
- Modify: `templates/tanstack-start-saas/src/bunderstack/env.ts`
- Modify: `templates/tanstack-start-saas/src/bunderstack/jobs.ts`
- Delete: `templates/tanstack-start-saas/src/bunderstack/trpc.ts`
- Modify: `templates/tanstack-start-saas/src/routes/admin/index.tsx`
- Modify: `templates/tanstack-start-saas/src/routes/app/projects.$projectId.tsx`
- Modify: `templates/tanstack-start-saas/src/routes/app/projects.tsx`
- Modify: `templates/tanstack-start-saas/src/routes/login.tsx`

- [ ] **Step 1: Migrate Todo as the minimal reference**

Use Valibot in custom procedures, one catch-all handler calling `app.handler`, and one client namespace for CRUD/custom/files/realtime. Add a documented webhook procedure using `o.webhook.route({ method: 'POST', path: '/webhooks/example' })` and raw-body verification.

- [ ] **Step 2: Migrate Twitter as the full reference**

Replace `api.api.*`, root REST table calls, and separate realtime setup with the unified client. Delete Hono/Zod dependencies from every migrated example and template. Keep the root Zod dev dependency until Task 13 migrates the last OpenAPI fixture.

- [ ] **Step 3: Remove stale imports across all examples**

Run: `rg -n "from ['\"]hono|@trpc/|from ['\"]zod|drizzle-zod|createRealtimeClient|\.api\.api|/files/|api/trpc" examples packages templates`

Expected: no framework-owned legacy usage. Application-only Zod usage is also migrated so workspace dependency checks can assert complete removal.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck:examples`

Expected: PASS.

```bash
git add examples templates bun.lock
git commit -m "docs: migrate examples to unified oRPC API"
```

### Task 13: Verify optional OpenAPI and mobile-client generation

**Files:**

- Modify: `packages/bunderstack/src/api/openapi-client-generation.test.ts`
- Modify: `packages/bunderstack/src/api/openapi.test.ts`
- Modify: `packages/bunderstack-query/src/schema.ts`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add failing opt-in/output tests**

Prove app boot and RPC calls succeed for a Standard Schema procedure whose OpenAPI converter is absent. Prove explicit spec generation names that procedure in the failure. Prove a Valibot `.output(...)` produces an exact response schema while an inferred-only handler does not block generation.

- [ ] **Step 2: Generate and compile the mobile-facing client fixture**

Generate OpenAPI from the routed graph, run `openapi-typescript`, and compile a fixture that calls CRUD, storage, and a custom routed procedure. Better Auth's schema remains merged as the single foreign handler spec.

Convert the fixture itself from Zod to Valibot, remove the root Zod dev dependency, and regenerate the lockfile. At this point no workspace code needs Zod.

- [ ] **Step 3: Verify and commit**

Run: `bun run test:orpc-contract`

Expected: PASS.

```bash
git add packages/bunderstack/src/api/openapi-client-generation.test.ts packages/bunderstack/src/api/openapi.test.ts packages/bunderstack-query/src/schema.ts package.json bun.lock
git commit -m "test: verify optional OpenAPI projection"
```

### Task 14: Enforce dependency boundaries and net-negative simplification

**Files:**

- Modify: `scripts/dependency-boundaries.test.ts`
- Modify: `scripts/bundle-boundaries.test.ts`
- Modify: `packages/bunderstack-query/src/entrypoints.test.ts`
- Modify: `README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `packages/bunderstack-query/README.md`
- Modify: `packages/bunderstack-sync/README.md`

- [ ] **Step 1: Tighten dependency-boundary tests**

Fail if runtime source or manifests contain Hono, tRPC, Zod, drizzle-zod, `@orpc/zod`, server-only oRPC packages in browser bundles, or removed public symbols. Assert the client bundle contains `@orpc/client` and TanStack utilities but not server/OpenAPI/Valibot converters.

- [ ] **Step 2: Update public documentation**

Document one procedure graph, semantic bases, optional `.output`, webhooks, canonical file URL, Publisher-backed realtime, and unified client calls. Remove Hono/tRPC/split-client instructions.

- [ ] **Step 3: Measure simplification**

Run:

```bash
git diff --numstat d6f2fa1 -- packages/bunderstack/src packages/bunderstack-query/src packages/bunderstack-sync/src
git diff --stat d6f2fa1 -- packages/bunderstack/src packages/bunderstack-query/src packages/bunderstack-sync/src
```

Expected: deleted production lines exceed added production lines, and deleted production files exceed newly created production files. If not, remove forwarding wrappers and duplicated helpers before proceeding.

- [ ] **Step 4: Run focused boundary verification and commit**

Run: `bun run test:boundaries`

Expected: PASS.

Run: `bun run test:bundles`

Expected: PASS.

```bash
git add scripts packages/bunderstack-query/src/entrypoints.test.ts README.md packages/bunderstack/README.md packages/bunderstack-query/README.md packages/bunderstack-sync/README.md
git commit -m "docs: document the oRPC-first architecture"
```

### Task 15: Full verification and final cleanup

**Files:**

- Modify only files implicated by verification failures.

- [ ] **Step 1: Prove no legacy runtime dependency remains**

Run: `rg -n "from ['\"]hono|@trpc/|from ['\"]zod|drizzle-zod|@orpc/zod|createRealtimeClient|clientId|gap" packages examples templates package.json`

Expected: no runtime/public API matches. A test may mention a removed string only when asserting absence.

- [ ] **Step 2: Run all package tests**

Run: `bun run test`

Expected: PASS. In restricted sandboxes, rerun `bun test src/storage/s3.test.ts` with loopback permission; the known baseline is 12/12 passing outside the bind restriction.

- [ ] **Step 3: Run all typechecks and contract checks**

Run: `bun run typecheck:all`

Expected: PASS.

Run: `bun run test:orpc-contract && bun run test:boundaries && bun run test:bundles`

Expected: PASS.

- [ ] **Step 4: Review the final public surface**

Verify a single `createBunderstack` construction path, one app handler, one inferred router carrier, one query-client namespace, and no compatibility wrappers. Re-run the numstat comparison against `d6f2fa1` and record totals in the commit body.

- [ ] **Step 5: Commit verification fixes**

```bash
git add -u
git add packages examples templates scripts README.md package.json bun.lock
git commit -m "test: verify oRPC-first simplification"
```

## Completion Criteria

- All commands in Task 15 pass with only the documented loopback permission exception.
- `rg` finds no Hono, tRPC, Zod, drizzle-zod, old realtime protocol, or split-client runtime surface.
- Todo and Twitter compile using one namespace and no separate realtime client.
- Webhook raw bytes, storage parity, scoped Publisher delivery, reconnect invalidation, and optional OpenAPI each have explicit tests.
- The production source comparison against `d6f2fa1` is materially net-negative.
