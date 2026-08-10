# Task 2 Report: Give generated CRUD procedures real schema/access types

## Overview
Task 2 has been completed successfully. Generated CRUD procedures now have precise typed shapes (`CrudApiRouterFor<TSchema, TAccess>`), exposing exposed table keys while preserving access rules and providing full type inference on procedures (`list`, `get`, `create`, `update`, `delete`) without `any`.

## Changes Summary

1. **Created `packages/bunderstack/src/api/types.ts`**:
   - `ExposedApiTables<TSchema, TAccess>`: Single type-level exposure utility mirroring server/client exposure rules (explicit access, auth table rules, convention keys, and disabled keys).
   - `CrudApiRouterFor<TSchema, TAccess>`: Maps exposed tables to typed `TableCrudProcedures<TTable>`.
   - `MergeApiRouterTypes<A, B>`: Recursively combines distinct procedure namespaces and rejects overlapping leaf procedure handles.
   - `UnifiedApiRouter<TCrud, TCustom>`: Merges generated CRUD procedure router and custom oRPC API router types.

2. **Updated `packages/bunderstack/src/api/crud-router.ts`**:
   - Implemented `buildTableCrudProcedures<TSchema, TTable extends Table>(args)` as a typed single-table procedure factory.
   - Exported `TableCrudProcedures<TTable>` as `ReturnType<typeof buildTableCrudProcedures<Record<string, unknown>, TTable>>`.
   - Created `updateInputSchema` using `z.object({ id: z.string(), ...mutableUpdateShape })`, omitting immutable `id` from mutable body while requiring `id` parameter.
   - Standardized `listOutputSchema` to match established Hono response (`items`, pagination metadata, omitting optional fields when absent, with no synthetic duplicate `data` field).

3. **Updated `packages/bunderstack/src/index.ts`**:
   - Updated `BunderstackApp`'s `$inferClient.api` carrier type to `UnifiedApiRouter<CrudApiRouterFor<TSchema, TAccess>, TCustomApiRouter>`.
   - Added `ZodToJsonSchemaConverter` from `@orpc/zod` to `OpenAPIGenerator` options.
   - Re-exported `ExposedApiTables`, `CrudApiRouterFor`, `UnifiedApiRouter`, `MergeApiRouterTypes`, and `TableCrudProcedures`.

4. **Updated `packages/bunderstack/package.json` & `bun.lock`**:
   - Declared peer dependencies for `@orpc/server`, `@orpc/openapi`, `@orpc/zod`, and `drizzle-zod` with optional flags in `peerDependenciesMeta`.
   - Regenerated `bun.lock` via `bun install`.

5. **Testing & Verification**:
   - `packages/bunderstack/src/api/api-types.types.ts`: Added positive & negative compile-time assertions (`_HasPosts`, `_HidesPrivateNotes`, `_HasStats`, `_CreateInput`, `_GetInput`, `_UpdateInput`, `_ListItems`).
   - `packages/bunderstack/src/api/crud-router.test.ts`: Added runtime tests verifying invalid update column types return 400, and OpenAPI PATCH request schema generation describes concrete column types.

## Review Findings & Fixes (2026-08-10)

1. **Fixed `updateInputSchema` Static Shape Preservation**:
   - Replaced `Record<string, z.ZodTypeAny>` with `omitIdShape(insertSchema.partial().shape)` extending `z.object({ id: z.string() })` in `packages/bunderstack/src/api/crud-router.ts`.
   - Preserves static TypeScript type inference for `update` procedure input (`{ id: string; title?: string }`).
   - `_UpdateInput` assertion in `packages/bunderstack/src/api/api-types.types.ts` passes `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json` cleanly.

2. **Unified Exposure Utility (`ExposedApiTables`)**:
   - Added `"./api": "./src/api/types.ts"` export to `packages/bunderstack/package.json`.
   - Updated `packages/bunderstack-query/src/infer.ts` to import and consume `ExposedApiTables` from `bunderstack/api`, eliminating duplicate exposure utilities in the codebase.

## Verification Results
- `bun test --cwd packages/bunderstack src/api/crud-router.test.ts` (3 pass, 0 fail)
- `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json` (Exit code 0)
- `bun test --cwd packages/bunderstack-query` (35 pass, 0 fail across 6 files)
- Commit: `fix(api): address task 2 review findings`

