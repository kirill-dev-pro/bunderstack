# Unified oRPC API Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that generated CRUD and custom endpoints can share one oRPC router, context, client namespace, collision validator, and OpenAPI document while preserving Bunderstack's current HTTP URLs.

**Architecture:** Add an oRPC API builder and request context beside the current implementation, then move CRUD execution behind generated oRPC procedures. Hono remains the private top-level dispatcher. Better Auth remains a foreign handler whose generated OpenAPI operations participate in the global registry and combined specification.

**Tech Stack:** Bun, TypeScript, oRPC v2 beta, Zod 4, Drizzle ORM, Better Auth, Hono, TanStack Query.

## Agent Instructions

1. Read `AGENTS.md` before changing files and use Bun for every command.
2. Work on branch `experiment/orpc-api` in this worktree; do not merge to `main`.
3. Run `bun run test` before editing. The known-good baseline is 575 passing
   workspace/script tests with one real-Postgres test skipped.
4. Use oRPC v2 packages pinned to the same beta version. At plan creation the
   current packages resolved to `2.0.0-beta.26`; update all oRPC packages
   together only if that exact version is no longer installable.
5. Do not delete `trpc:` or `routes:` during the spike. Keep them operational
   for existing tests while the two representative examples move to `api:`.
   Removal is a post-spike product decision.
6. Do not commit generated clients or broad formatting changes. Preserve
   unrelated files and existing public URLs.
7. After Tasks 1, 3, and 4, write a short go/no-go note in
   `docs/plans/2026-08-09-unified-orpc-api-findings.md`. Stop the experiment if
   oRPC cannot represent runtime-generated routers with usable TypeScript
   inference, preserve current CRUD wire formats, or generate a coherent
   OpenAPI document without maintaining a parallel route model.

## Global Constraints

- Do not introduce `/api/v1` or otherwise version the HTTP API.
- Preserve generated CRUD paths `/api/:table` and `/api/:table/:id`.
- Preserve Better Auth paths `/api/auth/*`.
- Use one `api:` authoring surface for new application endpoints.
- Keep Hono internal; do not expose it through the new application API.
- Use test-driven development for every behavior change.
- Treat this branch as a viability experiment; storage and realtime execution are out of scope.
- Keep legacy `trpc:` and `routes:` working during the experiment.
- Do not proxy CRUD through synthetic HTTP requests; extract transport-neutral operations.

---

### Task 1: oRPC builder and request context

**Files:**
- Create: `packages/bunderstack/src/api/context.ts`
- Create: `packages/bunderstack/src/api/builder.ts`
- Test: `packages/bunderstack/src/api/builder.test.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `createApiBuilder<TSchema, TEnv>()` returning `{ public, protected }`.
- Produces: `createApiContext(deps, request)` with memoized `getSession()`.
- `protected` adds non-null `user` and `session` to the procedure context.

- [ ] **Step 1: Write failing tests for public context, protected rejection, protected type narrowing, and one auth lookup per request.**
- [ ] **Step 2: Run `bun test --cwd packages/bunderstack src/api/builder.test.ts` and verify missing-module/API failures.**
- [ ] **Step 3: Add `@orpc/server`, `@orpc/openapi`, and `@orpc/zod` at `2.0.0-beta.26`, then implement the minimal builder and memoized context.**
- [ ] **Step 4: Run the focused tests and `bun run typecheck`.**
- [ ] **Step 5: Record whether the v2 builder API and Better Auth session middleware are viable, then commit `feat(api): add shared orpc context and builders`.**

### Task 2: Global route registry and collision validation

**Files:**
- Create: `packages/bunderstack/src/api/registry.ts`
- Test: `packages/bunderstack/src/api/registry.test.ts`
- Modify: `packages/bunderstack/src/routes.ts`

**Interfaces:**
- Consumes: oRPC router metadata and foreign OpenAPI path operations.
- Produces: `buildApiRegistry({ nativeRouter, foreignSpecs })`.
- Produces: normalized entries `{ handle, operationId, method, path, source }`.
- A collision key is the uppercase HTTP method plus a normalized OpenAPI path;
  `{id}` and `:id` normalize to the same parameter token.
- Static and parameter routes such as `/users/me` and `/users/{id}` may coexist;
  two parameter routes at the same position are ambiguous and must fail.

- [ ] **Step 1: Write failing tests for duplicate handles, duplicate operation IDs, exact method/path collisions, and ambiguous parameter paths.**
- [ ] **Step 2: Verify the tests fail because the registry does not exist.**
- [ ] **Step 3: Implement route normalization and aggregate construction errors that identify both sources.**
- [ ] **Step 4: Run focused tests and the existing route-collision tests.**
- [ ] **Step 5: Commit `feat(api): validate the unified route registry`.**

### Task 3: Generated CRUD procedures with unchanged URLs

**Files:**
- Create: `packages/bunderstack/src/api/crud-router.ts`
- Test: `packages/bunderstack/src/api/crud-router.test.ts`
- Modify: `packages/bunderstack/src/crud.ts`
- Modify: `packages/bunderstack/src/errors.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: schema, database, resolved access, idempotency, realtime, and the shared API builder.
- Produces: `buildCrudApiRouter(schema, db, options)` with `list`, `get`, `create`, `update`, and `delete` procedures per exposed table.
- Produces: `CrudApiRouterFor<TSchema, TAccess>` so client handles are inferred
  from the schema/access types rather than widened to `Record<string, unknown>`.
- HTTP metadata must map to the existing `/api/<table>` and `/api/<table>/{id}` paths.
- Runtime schemas come from `drizzle-zod`: select schemas describe rows, insert
  schemas describe creates, and partial insert schemas (excluding immutable
  IDs) describe updates. List output retains the current
  `{ data, nextCursor, hasMore, total? }` wire format.

- [ ] **Step 1: Write failing integration tests that call generated `posts.list` and `posts.create` through the oRPC OpenAPI handler at the existing URLs.**
- [ ] **Step 2: Add failing tests proving generated CRUD uses the shared session and preserves current access/error behavior.**
- [ ] **Step 3: Add a Zod-4-compatible `drizzle-zod` version and extract transport-neutral CRUD operations from `crud.ts` without changing behavior.**
- [ ] **Step 4: Generate oRPC procedures and runtime schemas around those operations; prove the return type retains literal table handles.**
- [ ] **Step 5: Run the new CRUD tests plus `crud.test.ts`, `crud.pg.test.ts`, and `crud-scope.test.ts`.**
- [ ] **Step 6: Record schema quality, inferred client shape, and any query-parameter mapping compromises; stop if a parallel hand-maintained schema is required.**
- [ ] **Step 7: Commit `feat(api): generate crud as orpc procedures`.**

### Task 4: Mount custom API and expose the combined OpenAPI document

**Files:**
- Create: `packages/bunderstack/src/api/openapi.ts`
- Test: `packages/bunderstack/src/api/openapi.test.ts`
- Modify: `packages/bunderstack/src/handler.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/auth.ts`

**Interfaces:**
- Adds `api: (o) => Router` to `createBunderstack` options.
- Mounts OpenAPI HTTP operations under their declared current paths.
- Mounts RPC transport at `/api/rpc/*`.
- Serves a merged OpenAPI 3.1 document at `/api/openapi.json`.
- Adds Better Auth's `openAPI()` plugin inside `createAuth` unless a plugin with
  the same ID is already present, then calls `auth.api.generateOpenAPISchema()`.
- Merging must rewrite Better Auth's base prefix exactly once, retain its
  cookies/security metadata, merge `components` by category, and fail on
  unequal duplicate component names rather than silently overwriting them.

- [ ] **Step 1: Write failing tests for a custom `api:` route, RPC invocation, and generated OpenAPI paths for CRUD and the custom route.**
- [ ] **Step 2: Write a failing test proving a custom route conflicting with CRUD prevents application construction.**
- [ ] **Step 3: Enable Better Auth OpenAPI generation without duplicating user plugins and add a failing assertion for an auth path in the combined document.**
- [ ] **Step 4: Implement handler mounting, spec merging, and registry validation.**
- [ ] **Step 5: Run focused integration tests, auth tests, and `bun run typecheck`.**
- [ ] **Step 6: Validate the merged JSON with an OpenAPI 3.1 parser and record Better Auth gaps; stop if auth paths cannot be merged deterministically.**
- [ ] **Step 7: Commit `feat(api): mount unified orpc and openapi handlers`.**

### Task 5: One TanStack Query client namespace

**Files:**
- Create: `packages/bunderstack-query/src/api.ts`
- Test: `packages/bunderstack-query/tests/api-client.test.ts`
- Modify: `packages/bunderstack-query/src/client.ts`
- Modify: `packages/bunderstack-query/src/index.ts`
- Modify: `packages/bunderstack-query/src/infer.ts`
- Modify: `packages/bunderstack-query/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces one `createClient<App>()` surface containing generated resource procedures and custom procedures.
- Uses oRPC TanStack Query utilities for both categories.
- Adds `@orpc/client` and `@orpc/tanstack-query` at the same beta version as
  the server packages. Keep those imports isolated from the lightweight schema
  entrypoint so the existing dependency-boundary tests remain meaningful.

- [ ] **Step 1: Write failing type/runtime tests for `api.posts.list.queryOptions()` and a custom `api.stats.queryOptions()`.**
- [ ] **Step 2: Verify the current REST-plus-`trpc` client cannot satisfy the desired surface.**
- [ ] **Step 3: Implement the oRPC transport and TanStack Query proxy with lazy construction.**
- [ ] **Step 4: Run query package tests and root typecheck.**
- [ ] **Step 5: Commit `feat(query): expose one orpc client namespace`.**

### Task 6: Migrate representative examples and evaluate the experiment

**Files:**
- Modify: `examples/todo/src/bunderstack.ts`
- Modify: `examples/todo/src/api-client.ts`
- Modify: `examples/todo/src/routes/index.tsx`
- Modify: `examples/todo/src/routes/b.$boardId.tsx`
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Modify: `examples/twitter-tanstack/src/hooks/use-feed.ts`
- Create: `docs/plans/2026-08-09-unified-orpc-api-findings.md`

**Interfaces:**
- Consumes: the new server `api:` builder and unified client.
- Produces: two realistic DX examples and a keep/change/stop recommendation.

- [ ] **Step 1: Replace Todo's tRPC procedures with `api:` procedures and keep its CRUD URLs unchanged.**
- [ ] **Step 2: Replace Twitter's feed procedure and client usage.**
- [ ] **Step 3: Run `bun run typecheck:examples` and the example contract tests.**
- [ ] **Step 4: Generate `/api/openapi.json` in a test fixture and validate that its CRUD, custom, and auth operations can be consumed by an OpenAPI client generator.**
- [ ] **Step 4a: Do not commit the generated mobile client; compile a temporary generated client as evidence and discard it after the check.**
- [ ] **Step 5: Record dependency weight, API ergonomics, type-check performance, Better Auth limitations, and remaining storage/realtime work in the findings document.**
- [ ] **Step 6: Run `bun run test`, `bun run typecheck:all`, and `bun run test:boundaries`.**
- [ ] **Step 7: Commit `docs: evaluate unified orpc api experiment`.**
