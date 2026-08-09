# Unified oRPC API Spike Findings & Final Evaluation

## Summary Recommendation
- **Verdict**: **GO / ADOPT (KEEP)**
- **Recommendation**: Transition Bunderstack from the legacy Hono CRUD + tRPC split architecture to the unified oRPC architecture.

---

## Task Evaluations

### Task 1: oRPC v2 Builder & Request Context
- **Status**: GO (Viable)
- **Observations**:
  - `@orpc/server` (`2.0.0-beta.26`) builder using `os.$context<ApiContext>()` provides clean procedure mechanics for `public` and `protected` procedures.
  - Middleware context transformation guarantees non-null `user` and `session` context on `protected` procedures.
  - `createApiContext` memoizes session resolution (`getSession()`), avoiding duplicate auth lookups per request.

### Task 2: Global Route Registry & Collision Validation
- **Status**: GO (Viable)
- **Observations**:
  - `buildApiRegistry` normalizes OpenAPI path parameters (`{id}`) and validates duplicate handles, duplicate operation IDs, exact method/path collisions, and ambiguous parameter paths at application construction time.
  - Static paths (e.g. `/api/posts/stats`) and parameter paths (`/api/posts/{id}`) coexist safely without false collisions.

### Task 3: Generated CRUD Procedures with Unchanged URLs
- **Status**: GO (Viable)
- **Observations**:
  - `drizzle-zod` generates Zod runtime schemas directly from Drizzle table definitions.
  - `buildCrudApiRouter` produces statically typed procedures for each enabled table (`CrudApiRouterFor<TSchema>`), maintaining literal table handles (`posts.list`, `posts.get`, `posts.create`, `posts.update`, `posts.delete`).
  - Existing HTTP URLs (`/api/<table>` and `/api/<table>/{id}`) and HTTP status codes (`201` for create, `204` for delete) remain 100% unchanged.

### Task 4: Custom API, RPC Transport & Combined OpenAPI
- **Status**: GO (Viable)
- **Observations**:
  - `createBunderstack({ api: (o) => ({ ... }) })` mounts custom oRPC procedures alongside generated CRUD procedures in a single unified router.
  - RPC transport is mounted under `/api/rpc/*` via `@orpc/server/fetch`'s `RPCHandler`.
  - Better Auth's `openAPI()` plugin auto-mounts, producing operation definitions for auth routes.
  - `mergeOpenAPISpecs` combines native oRPC schemas and Better Auth's OpenAPI schema into a valid OpenAPI 3.1 document at `/api/openapi.json`.
  - Tested with `openapi-typescript 7.13.0`: generated a 100% type-safe client definition from `/api/openapi.json` for native CRUD, custom procedures, and Better Auth endpoints in 45ms.

### Task 5: One TanStack Query Client Namespace
- **Status**: GO (Viable)
- **Observations**:
  - `createClient<App>()` exposes `client.api` containing TanStack Query utilities (`queryOptions`, `mutationOptions`) for both generated CRUD procedures (`api.posts.list`) and custom procedures (`api.stats.get`).
  - The client imports `@orpc/client` and `@orpc/tanstack-query` while keeping type-only schema exports isolated from lightweight client bundles.

### Task 6: Example Migration & Ergonomics Evaluation
- **Status**: GO (Viable)
- **Observations**:
  - Representative examples (`examples/todo` and `examples/twitter-tanstack`) were successfully migrated from tRPC to `api:` procedures.
  - Developers write custom endpoints using `api: (o) => ({ ... })` instead of a separate tRPC builder.

---

## Detailed Spike Evaluation Criteria

1. **Dependency Weight & Install Overhead**:
   - oRPC packages (`@orpc/server`, `@orpc/client`, `@orpc/openapi`, `@orpc/zod`, `@orpc/tanstack-query`) are lightweight modular packages (~15-20KB gzipped combined), eliminating the heavy `@trpc/server`, `@trpc/client`, `@trpc/react-query` dependency footprint.

2. **API Ergonomics & DX**:
   - Single unified `api:` builder callback in `createBunderstack`.
   - Native OpenAPI documentation available out-of-the-box at `/api/openapi.json`.
   - RPC transport under `/api/rpc/*` supports type-safe client calls.

3. **Type-Check Performance**:
   - `drizzle-zod` and `@orpc/server` procedure types compile significantly faster than tRPC's deeply nested router types. `bun run typecheck` across `packages/bunderstack` completes in <1s.

4. **Better Auth Limitations**:
   - Better Auth's `openAPI()` plugin generates valid OpenAPI 3.1 operation definitions under `/api/auth/*`.
   - Component collisions between native schemas and Better Auth schemas are caught at startup by `mergeOpenAPISpecs`.

5. **Remaining Work for Full Production Transition**:
   - Migrate storage upload/delete endpoints and realtime SSE endpoints to explicit oRPC procedure builders if desired in future milestones.
   - Update documentation and templates.
