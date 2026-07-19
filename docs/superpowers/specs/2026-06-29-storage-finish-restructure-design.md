# Finish multi-bucket storage: directory restructure + TypeScript fixes

Date: 2026-06-29
Branch: multi-bucket-storage
Package: `packages/bunderstack`

## Context

The multi-bucket storage feature is functionally complete: 116 storage tests
pass, there are no TODO/FIXME markers in `src/`, and the working tree is clean.
The remaining loose ends are cosmetic but worth closing before merge:

1. The `src/` layout is inconsistent. `storage/` is a folder grouping 10
   related files, but `realtime` — which also spans two source files
   (`realtime.ts` + `realtime-redis.ts`) — is flat at the top level. Tests are
   also split: most module tests live in `src/` next to their code, while
   storage's tests live in a separate `tests/storage/` tree.
2. Five TypeScript errors remain (`bunx tsc --noEmit`):
   - 3 in `src/index.ts` (lines 116, 124, 135) — the raw better-auth instance
     no longer structurally satisfies our internal `AuthSessionResolver`.
   - 2 in `tests/db.test.ts` (lines 20, 23) — a drizzle-orm dual-instance type
     mismatch.

This spec covers the restructure and the two TypeScript fixes. No behavior
changes; all 116 tests must still pass and `tsc --noEmit` must reach zero errors.

## Goals

- One consistent rule for module layout: multi-file domains are folders.
- One consistent rule for tests: co-located with their source under `src/`.
- Zero TypeScript errors from `bunx tsc --noEmit`.
- No runtime behavior change; the test suite stays green throughout.

## Non-goals

- No new storage functionality (the feature is complete).
- No grouping of single-file singletons into folders (`auth.ts`, `config.ts`,
  `db.ts`, etc. stay flat).
- No drizzle-orm dependency deduplication / install-override changes.
- No unrelated refactoring.

## Section 1 — Directory restructure

A domain earns a folder only when it has more than one source file. `realtime`
has two (`index.ts` + `redis.ts`) and becomes a folder; `crud` is a single
source file and stays flat as `crud.ts`. All tests co-locate under `src/` —
flat next to flat source, inside the folder for foldered domains.

Target layout:

```
src/
  realtime/
    index.ts          # from realtime.ts
    redis.ts          # from realtime-redis.ts
    *.test.ts         # realtime.test.ts, realtime-sse.test.ts (from src/),
                      #   realtime-redis.test.ts
  storage/            # already a folder; pull tests/storage/*.test.ts (9 files)
                      #   in alongside source
    *.ts
    *.test.ts
  # singletons stay flat (crud included — one source file):
  access.ts  auth.ts  config.ts  crud.ts  db.ts  errors.ts  handler.ts
  idempotency.ts  index.ts  internal-tables.ts  list-query.ts
  provision.ts  rate-limit.ts  scope.ts  typeid.ts
```

Test relocation, exhaustively:

| Destination                             | Test files moved in                                                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/realtime/`                         | `src/realtime.test.ts`, `src/realtime-sse.test.ts`, `src/realtime-redis.test.ts`                                                                                                                                                        |
| `src/storage/`                          | all 9 of `tests/storage/*.test.ts`                                                                                                                                                                                                      |
| `src/` (flat, from `tests/`)            | `crud.test.ts`, `access.test.ts`, `access.integration.test.ts`, `auth.test.ts`, `config.test.ts`, `db.test.ts`, `internal-tables.test.ts`, `provision.test.ts`, `provision.integration.test.ts`, `rate-limit.test.ts`, `typeid.test.ts` |
| `src/` (flat, already there, unchanged) | `crud-broadcast.test.ts`, `crud-scope.test.ts`, `access-sanitize.test.ts`, `config-access.test.ts`, `index.test.ts`, `scope-where.test.ts`, `scope.test.ts`                                                                             |

No filename collisions exist between the `tests/` files moving to flat `src/`
and the tests already there (e.g. `access.test.ts` vs the existing
`access-sanitize.test.ts`).

Decisions:

- `realtime/` uses `index.ts` + `redis.ts` (not a `core.ts` + barrel split) —
  fewer files, matches storage's flat-ish style.
- `crud` stays a flat `crud.ts`: a folder for a single source file is ceremony,
  not structure. A domain earns a folder only when it has 2+ source files.

Import updates:

- `src/index.ts`: `./realtime.ts` -> `./realtime/index.ts`,
  `./realtime-redis.ts` -> `./realtime/redis.ts`. `./crud.ts` is unchanged.
- Any other importers of `realtime`, `realtime-redis` update to the new paths.
- Test files update their relative imports to the source under the new tree.
- The `tests/` directory is emptied and removed. `tsconfig.json` `include`
  already covers `src/**/*.ts`; the `tests/**/*.ts` glob becomes a no-op and may
  be left as-is or trimmed.

Verification: `bun test` (116+ pass, 0 fail) after the moves.

## Section 2 — TypeScript fix: auth resolver (3 errors)

Root cause: better-auth 1.6.20 types `api.getSession` as a _union_ return. One
branch is the bare `{ session, user }` object; the other is a
`{ headers, response }` wrapper (the `returnHeaders`/`asResponse` overload). The
wrapper branch has no top-level `user`, so the raw `auth` instance no longer
structurally satisfies our minimal `AuthSessionResolver` (defined in
`src/access.ts`). Our logic is correct; only the structural match broke after the
better-auth bump.

Fix: adapter at the boundary. `AuthSessionResolver` remains our stable internal
contract. In `src/index.ts`, wrap `auth` once into a small adapter that calls
`auth.api.getSession({ headers })`, defensively narrows the union
(`if (result && 'user' in result)`), and returns our `{ user, session }` shape
(or `null`). The adapter is passed to `buildCrudRouter`, `buildRealtimeRouter`,
and `buildBucketStorageRouter` in place of the raw `auth`. Internal modules keep
depending on the clean `AuthSessionResolver` interface; better-auth's evolving
types are absorbed in exactly one place. This matches the project philosophy of
composing and adapting raw instances rather than coupling internals to upstream
types.

Rejected alternatives:

- Cast `auth as unknown as AuthSessionResolver` at the 3 call sites — hides the
  real runtime shape and repeats the cast.
- Widen `AuthSessionResolver` to match better-auth's union — couples our
  internals to upstream types; breaks on the next better-auth change.

Note: `app.auth` continues to expose the raw better-auth instance unchanged; the
adapter is internal wiring only.

## Section 3 — TypeScript fix: `db.test.ts` (2 errors)

Root cause: two physical copies of drizzle-orm 0.45.2 are installed under
`node_modules/.bun` with different peer-dependency hashes (`+24fdea36...`
resolved at the workspace root, `+ceed124c...` resolved for the bunderstack
package). The test imports `posts` from `examples/standalone/schema` (built with
the root's drizzle) while `createDb` uses the package's drizzle. Drizzle brands
its `SQLiteColumn`/`SQLiteTable` types per module instance, so the two are
nominally incompatible.

Fix: local fixture. A package unit test should not reach into `examples/`.
Define a minimal `posts` table inside the test file using the package's own
drizzle-orm import (`drizzle-orm/sqlite-core`). The assertion intent is
unchanged — `createDb` returns a working Drizzle instance against in-memory
SQLite. This dovetails with Section 1: the file becomes `src/db.test.ts`.

Rejected alternatives:

- Dedupe drizzle-orm via install overrides/resolutions — fragile across Bun
  installs and unrelated to what this test verifies.
- Cast the table in the test — hides the instance mismatch instead of removing
  it.

## Verification

1. `bunx tsc --noEmit` in `packages/bunderstack` -> 0 errors.
2. `bun test` in `packages/bunderstack` -> all pass, 0 fail (>= 116).
3. `git status` reviewed; `tests/` removed, new folders present.

## Order of work

1. Section 3 fix (self-contained, unblocks moving `db.test.ts`).
2. Section 2 fix (self-contained in `index.ts` + `access.ts`).
3. Section 1 restructure (the moves; run tests after).

Sections 2 and 3 are independent of the restructure and reduce churn if done
first, so the final move is purely mechanical.
