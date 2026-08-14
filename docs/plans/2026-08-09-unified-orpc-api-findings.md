# Unified oRPC API Spike & Hardening Findings & Final Evaluation

## Summary Recommendation

- **Verdict**: **GO / ADOPT (HARDENED & VERIFIED)**
- **Recommendation**: Transition Bunderstack from the legacy Hono CRUD + tRPC split architecture to the unified oRPC architecture.

---

## Hardening Pass Evaluation & Empirical Evidence

### Task 1: Preserve Custom oRPC Router Inference

- **Status**: GO (Verified)
- **Evidence**:
  - Threaded generic `TCustomApiRouter extends AnyRouter | undefined` through `BunderstackConfig`, `resolveConfig`, `createBunderstack` overloads, and `BunderstackApp`.
  - Added `api: TApiRouter` to `BunderstackApp['$inferClient']` phantom type carrier.
  - Compile-time type assertions in `api-types.types.ts` verify contextual type inference for `o.protected`, `context.user.id`, `context.db`, `context.env`, and `input` without `any` annotations.

### Task 2: Infer Generated CRUD Procedure Types

- **Status**: GO (Verified)
- **Evidence**:
  - Created `packages/bunderstack/src/api/types.ts` exporting `ExposedApiTables`, `CrudApiRouterFor<TSchema, TAccess>`, and `UnifiedApiRouter`.
  - Extracted `buildTableCrudProcedures` in `crud-router.ts` using `insertSchema.omit({ id: true }).partial()` for updates, maintaining exact TypeScript shapes (e.g. `{ id: string; title?: string }`).
  - Single exported `ExposedApiTables` server/client exposure utility consumed by `bunderstack-query`.

### Task 3: End-to-End Type-Safe `client.api`

- **Status**: GO (Verified)
- **Evidence**:
  - Updated `bunderstack-query` to expose `client.api` typed with `ApiQueryUtils<TRouter> = RouterUtils<RouterClient<TRouter>>`.
  - Removed all `as any` casts from runtime test `api-client.test.ts`.
  - Added active compile-time negative type tests in `api-client-types.types.ts` (`@ts-expect-error` for missing inputs, wrong return types, non-existent routes, and disabled CRUD tables).
  - Verified `bun run test:boundaries` and `bun run test:bundles` pass without leaking imports to lightweight client roots.

### Task 4: Canonical Route and OpenAPI Collision Validation

- **Status**: GO (Verified)
- **Evidence**:
  - Replaced permissive `__collision` renaming in router composition with `mergeApiRoutersStrict` throwing on duplicate handles (e.g. `posts.list`).
  - Added `normalizeForeignOpenAPISpec` to canonicalize foreign OpenAPI specs (e.g. Better Auth `/api/auth/*`) before registry validation and spec merging.
  - Strict OpenAPI path overwrite check in `mergeOpenAPISpecs` rejecting overlapping path operations unless structurally equal.

### Task 5: Transport-Neutral CRUD Execution Core

- **Status**: GO (Verified)
- **Evidence**:
  - Created `createCrudOperations(deps)` in `packages/bunderstack/src/crud-operations.ts` containing pure execution logic for `list`, `get`, `create`, `update`, and `delete`.
  - Refactored `crud.ts` (Hono) and `api/crud-router.ts` (oRPC) into thin adapters; neither adapter contains direct Drizzle queries, access checks, scope stamping, idempotency persistence, or realtime publication.
  - Adapter parity tests in `crud-operations.test.ts` verify 100% status code, payload, error envelope, scope, idempotency replay, and realtime event parity across both transports.

### Task 6: Reproducible OpenAPI Client Generation & Example Ergonomics

- **Status**: GO (Verified)
- **Evidence**:
  - Created `packages/bunderstack/src/api/openapi-client-generation.test.ts` testing pinned `openapi-typescript@7.13.0` binary code generation in `mkdtemp()` and compilation with `tsc --noEmit`.
  - Removed explicit `any` / `{ context: any; input: any }` annotations from `examples/todo` and `examples/twitter-tanstack`.
  - Added root verification command `bun run test:orpc-contract`.

### Final Corrective Pass: Contract and Runtime Guardrails

- **Status**: GO (Verified)
- **Evidence**:
  - Aligned `ExposedApiTables<TSchema, undefined>` with runtime access resolution: only tables following the `userId` convention are exposed when explicit access rules are absent.
  - Applied the shared Bunderstack route collision validator to native oRPC procedures, reserving built-in health, OpenAPI, RPC, auth, tRPC, files, and realtime URLs at application construction time.
  - Marked the oRPC and `drizzle-zod` runtime imports as mandatory peers and added package-boundary assertions for their metadata.
  - Preserved the exact raw request body for oRPC idempotency hashing, including whitespace differences, instead of reconstructing JSON from parsed input.
  - Replaced public client `fetch` escape hatches with a request-typed adapter while preserving relative URLs for the standard browser fetch path.
  - Converted oRPC/OpenAPI tests to in-memory PGlite databases so verification leaves no generated database directories in the worktree.

---

## Suite Verification Summary

- **Unit & Integration Tests**: `bun run test` (607 pass, 1 skip, 0 fail across 89 files).
- **ORPC Contract Generation**: `bun run test:orpc-contract` (1 pass, 0 fail).
- **TypeScript Typechecks**: `bun run typecheck:all` (0 errors across packages and 5 examples).
- **Dependency Boundaries**: `bun run test:boundaries` (9 pass, 0 fail).
- **Browser Bundle Boundaries**: `bun run test:bundles` (2 pass, 0 fail).

---

## Final Decision

**GO / ADOPT**: The unified oRPC architecture has been thoroughly hardened, refactored onto a single CRUD execution core, and verified end-to-end for type-safety and OpenAPI contract generation.
