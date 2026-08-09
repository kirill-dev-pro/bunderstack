# Unified oRPC API Spike Findings

## Task 1 Evaluation: oRPC v2 Builder & Request Context

- **Status**: GO (Viable)
- **Observations**:
  - `@orpc/server` (version `2.0.0-beta.26`) builder API using `os.$context<ApiContext>()` provides clean procedure builder mechanics with `public` and `protected` variants.
  - Middleware context transformation nicely narrows context to guarantee non-null `user` and `session` on `protected` procedures.
  - `createApiContext` successfully memoizes session resolution (`getSession()`), ensuring at most one auth lookup per request even when context or session is accessed repeatedly across middleware and handlers.
  - Unauthenticated access on `protected` procedures throws an `ORPCError` with code `'UNAUTHORIZED'` as expected.

## Task 3 Evaluation: Generated CRUD Procedures with Unchanged URLs

- **Status**: GO (Viable)
- **Schema Quality & Inferred Client Shape**:
  - `drizzle-zod` generates runtime schemas directly from Drizzle tables without requiring any parallel hand-maintained schemas.
  - `selectSchema` describes output rows, `insertSchema` describes creation payloads, and `updateSchema` (partial insert without `id`) describes patch payloads.
  - `buildCrudApiRouter` produces statically typed procedures for each enabled table in the schema (`CrudApiRouterFor<TSchema>`), retaining literal table handles (`posts.list`, `posts.get`, `posts.create`, `posts.update`, `posts.delete`).
  - Existing HTTP URLs (`/api/<table>` and `/api/<table>/{id}`) are preserved with standard HTTP methods (`GET`, `POST`, `PATCH`, `DELETE`).
- **Query Parameter & HTTP Status Mapping**:
  - `OpenAPIHandler` maps path parameters (`{id}`) and request body into oRPC procedure `input` seamlessly.
  - `successStatus: 201` for `create` and `successStatus: 204` for `delete` preserve expected HTTP status codes.
  - Returned list structure contains `items` and `data` arrays, preserving full compatibility with Bunderstack's pagination format.
