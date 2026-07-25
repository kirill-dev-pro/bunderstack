# Static Dependency Boundaries & Type Safety Design Spec

**Date:** 2026-07-25  
**Topic:** Remediation Plan for PR #6 (`static-dependency-boundaries`) & Avoidable `any` Cleanup  
**Target:** `bunderstack` (Monorepo)  
**Starting Point:** Branch `static-dependency-boundaries` at commit `650541d` (PR #6 Head)

## 1. Context & Goal

The `static-dependency-boundaries` feature (PR #6) refactored `bunderstack` so that optional integrations (database drivers, SMTP provider, tRPC/Schema for React Query, Better Auth for Start) are loaded only through explicit subpath entrypoints (e.g. `bunderstack/database/libsql`, `bunderstack/email/smtp`, `bunderstack-query/trpc`, `bunderstack-start/auth`) rather than computed runtime `import()` calls or bundler ignore directives (`@vite-ignore`, `webpackIgnore`).

Code review of commit `650541d` revealed the following technical gaps:
1. **Database Connection Leak**: Adapter connection instances were created, but `app.close()` or initialization failure did not close the underlying database connections.
2. **Unsafe Introspection**: Offline introspection (`BUNDERSTACK_INTROSPECT=1`) attempted network/disk access on server Postgres adapters instead of returning Drizzle mocks.
3. **Peer Dependencies Metadata**: `better-auth` was listed as an optional peer in `packages/bunderstack/package.json` despite being statically imported by the main entrypoint (`src/index.ts`), and `nodemailer` had an empty range string.
4. **TS Directives & Bundle Leaks**: Published TypeScript sources contained `@ts-nocheck` comments (in `auth.ts` and `isomorphic-fetch.ts`), and `bunderstack-query/client` pulled in value imports of `QueryClient`.
5. **Avoidable `any` Usages**: Four specific avoidable `any` usages were identified in core sources (`trpc.ts`, `smtp.ts`, `realtime-client.ts`, `config.ts`).
6. **Workspace Examples Typecheck**: Examples (`examples/todo`, `examples/tldraw`, `examples/kanban-tanstack`) fail `tsc --noEmit` and are not included in root `npm run typecheck`.

This design spec provides a complete remediation plan starting directly from `650541d` to bring PR #6 to a production-ready, leak-free, and type-safe state.

## 2. Architecture & Design Decisions

### 2.1 Database Adapter Contract & Complete Lifecycle Guarantees
- `DatabaseAdapter` interface requires `connect()` to return `DatabaseConnectionResult<TSchema>` containing `{ db: DbFor<TSchema>, close?: () => void | Promise<void> }`.
- `createBunderstack` registers `close` with `Lifecycle` immediately after `createDb`.
- **Lifecycle Guarantees & Verification**:
  1. `app.close()` closes the database connection exactly once.
  2. Repeated calls to `app.close()` are idempotent.
  3. Failed application initialization (e.g., in subsequent setup steps) invokes `close()` on the database adapter.
  4. Initialization errors and cleanup errors are aggregated in `AggregateError` while preserving the original cause.
- **Offline Introspection**: When `introspect` is `true`, all built-in adapters (`libsql`, `pglite`, `bunSql`, `postgresJs`) return `{ db: drizzle.mock({ schema }) }` without opening files or connecting over network.

### 2.2 Refined Type-Safety (Targeted `any` Elimination)
- **`bunderstack-query/src/trpc.ts`**: Replace `let trpcProxy: any` with strict generic type `let trpcProxy: TRPCOptionsProxy<AnyRouter> | undefined`.
- **`bunderstack/src/email/smtp.ts`**: Cleanly type `createTransport` using nodemailer's `Transporter` return type interface without double `as unknown as Any` casts.
- **`bunderstack-query/src/realtime-client.ts`**: Replace `(data as any).clientId` with safe runtime type guarding:
  ```ts
  const candidate = (data as { clientId?: unknown }).clientId
  if (typeof candidate === 'string' && candidate.length > 0) {
    clientId = candidate
  }
  ```
- **`bunderstack/src/config.ts`**: Replace `z.any()` for `access` and `database.adapter` Zod schema properties with `z.unknown()`.

### 2.3 Package Manifests & Published Source Cleanliness
- **`packages/bunderstack/package.json`**:
  - `better-auth`: `^1.0.0` in `peerDependencies` (required peer).
  - `nodemailer`: `>=6 <10` in `peerDependencies` (optional peer, `peerDependenciesMeta.nodemailer.optional = true`).
  - `typescript`: `>=5` in `peerDependencies` (optional peer).
- **Prohibition of `@ts-nocheck`**: Remove all `@ts-nocheck` comments from `packages/bunderstack/src/auth.ts` and `packages/bunderstack-start/src/isomorphic-fetch.ts`.

### 2.4 Workspace Examples Typecheck Coverage
- Add `"typecheck:examples"` script to root `package.json` compiling all example tsconfigs (`todo`, `tldraw`, `kanban-tanstack`, `twitter-tanstack`, `twitter-db-tanstack`).
- Add `"typecheck:all"` script running both package typechecks and example typechecks.
- Fix example type compilation errors without resorting to `@ts-nocheck`, `any`, or unsafe type suppressions:
  - `examples/todo`: Add `"bun"` to `compilerOptions.types`.
  - `examples/tldraw`: Align `@tanstack/db` collection types and generic constraints.
  - `examples/kanban-tanstack`: Add missing type declarations for `oat.min.js`.

## 3. Scope & Verification Criteria

- Full package test suite passes 100% (`bun run test`).
- Core package typecheck passes 0 errors (`bun run typecheck`).
- All workspace examples typecheck passes 0 errors (`bun run typecheck:examples`).
- Browser bundle for `bunderstack-query` remains < 32 KiB and contains no `@trpc`, `superjson`, or `better-auth` imports.
