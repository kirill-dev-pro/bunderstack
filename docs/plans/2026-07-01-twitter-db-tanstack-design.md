# twitter-db-tanstack: TanStack DB + shadcn/ui example, plus bunderstack-sync

Date: 2026-07-01
Status: Approved design, pre-implementation
Scope: new `packages/bunderstack-sync` package, a small pluggable-`apply`
refactor of `packages/bunderstack-query/src/realtime-client.ts`, and a new
`examples/twitter-db-tanstack` example. Does not modify `examples/twitter-tanstack`
or `packages/bunderstack-query`'s default (react-query) behavior.

## Goal

`examples/twitter-tanstack` (react-query + `bunderstack-query` + oat) gets a
sibling example, same feature set, built on:

- **Data layer:** TanStack DB collections (`@tanstack/react-db` +
  `@tanstack/query-db-collection`) with `useLiveQuery`/`useLiveInfiniteQuery`,
  synced live over Bunderstack's existing (currently unused by any example)
  SSE realtime broker — instead of react-query hooks + hand-built
  `authorMap`/`byColumnIn` joins.
- **UI layer:** Tailwind v4 + shadcn/ui (Radix-based) + `sonner` for toasts —
  instead of `@knadh/oat`.

Both examples stay runnable side by side (different ports) as a real
comparison of the two data-fetching approaches on the same app and backend.

## Why bunderstack-sync, not ad hoc collection code in the example

`bunderstack-query` already does the analogous thing for TanStack Query:
`createBunderstackQueryClient().with({ tables, buckets, queryClient })` turns
a Drizzle schema into typed `listQuery`/`getQuery`/`*Mutation` hooks. A
`bunderstack-sync` package extends that same convention to TanStack DB —
`.with({ tables, buckets, queryClient, realtime: true })` returns a map of
ready-to-use DB collections instead. This makes the example thinner (one
function call for collection setup) and gives every future Bunderstack +
TanStack DB app the same thing for free.

---

## 1. `packages/bunderstack-sync`

Mirrors `bunderstack-query`'s shape and file layout:

```ts
createBunderstackSyncClient<TSchema>()
  .withTables({ queryClient, fetch, tables: [...] as const, realtime: true })
  .withSchema({ schema, queryClient, realtime: true })
  .with({ tables, buckets, queryClient, realtime: true })
```

- Returns `{ posts: Collection<...>, user: Collection<...>, ..., files: {...} }`.
- `.files` is delegated unchanged from `bunderstack-query`'s `createBucketClient`
  — uploads aren't collections, no DB binding needed.
- Depends on `bunderstack-query` (workspace) for `createTableClient` (REST
  primitives) and the realtime SSE client (reconnect/backoff/watchdog/gap
  recovery) — no duplication of that logic.
- New package, not folded into `bunderstack-query`, so apps that want only
  one data layer don't carry the other's peer deps
  (`@tanstack/react-db`, `@tanstack/query-db-collection`).
- `getKey: (item) => item.id` — safe default; every Bunderstack CRUD table
  uses `id` as its primary key by convention.
- No Zod `schema` validation in `queryCollectionOptions` for the `.withTables`
  path (type-only schema, matches `bunderstack-query`'s client-bundle-safety
  invariant — the Drizzle schema is never imported as a value there).
  `.withSchema` *could* auto-derive Zod via `drizzle-zod` later; out of scope
  for v1.

### Realtime sync: surgical writes, not invalidate-everything

`bunderstack-query`'s `realtime-client.ts` currently hardcodes its `apply()`
step as `queryClient.setQueryData(...)` + `invalidateQueries(...)`. For
collections, invalidating a list query on every single create/update/delete
would force a full table refetch for every connected client on every write —
exactly the "fetch more than needed" failure class this session spent a lot
of effort eliminating from `twitter-tanstack` at 25k-post stress-test scale.

Instead: extract `apply()` into a pluggable strategy parameter on
`createRealtimeClient` (small, non-breaking — `bunderstack-query`'s default
behavior is unchanged, existing tests must keep passing as-is).
`bunderstack-sync` supplies an `apply` that calls
`collections[table].utils.writeUpsert(record)` on create/update and
`collections[table].utils.writeDelete(record.id)` on delete — TanStack DB's
documented direct-write API for exactly this "external event → patch the
synced store" case. No refetch, no over-fetching, one record patched per event.

---

## 2. `examples/twitter-db-tanstack`

- Copied from `twitter-tanstack`: `schema.ts`, `access.ts`, `bunderstack.ts`
  (auth/storage config) carry over close to unchanged; `bunderstack.ts` adds
  `realtime: true`.
- Routes/components rewritten against `bunderstack-sync` collections +
  `useLiveQuery` (joins replace `authorMap`) + `useLiveInfiniteQuery`
  (pagination — `pageSize: 20`, mirroring the cursor logic from
  `twitter-tanstack`). **Needs empirical verification once built**: confirm
  `useLiveInfiniteQuery`'s windowing actually bounds the underlying HTTP
  fetch and doesn't just window over an already-fully-synced collection —
  re-run `stress-seed` against this example and check network behavior, the
  same way pagination was verified for `twitter-tanstack`.
- Full feature parity: feed, threads, profiles, follow/like/retweet, search,
  image upload + thumbnails, infinite scroll.
- File uploads stay plain async calls via `bunderstack-sync`'s `.files`
  surface (same shape as `twitter-tanstack`'s `filesApi`).

### UI layer

- Tailwind v4 (CSS-first config, `@tailwindcss/vite`) + `bunx shadcn@latest
  init` (Vite preset), components in `src/components/ui/`.
- Components: `Button`, `Card`, `Avatar`, `Dialog`, `AlertDialog` (replaces
  the native `confirm()` currently used for post delete), `Input`,
  `Textarea`, `Tabs` (For You / Following), `Skeleton`, `Separator`, `sonner`
  for toasts.
- Dark mode: automatic via `prefers-color-scheme` only (matches oat's current
  behavior — no manual toggle today, easy to add later).
- Visual direction (color/typography/spacing decisions) deferred to the
  `frontend-design` skill during implementation, not decided in this doc —
  default to shadcn's neutral palette + one accent color as a starting point.

### Repo wiring

- New port (3003, next free one after 3000/3001/3002/5174/5175).
- `dev:twitter-db-tanstack` script at root, new row in `examples/README.md`.

---

## 3. Verification plan

- `bun test` for `packages/bunderstack-sync` (collection creation, mutation
  handlers call the right REST methods, realtime `apply` calls
  `writeUpsert`/`writeDelete` correctly).
- `packages/bunderstack-query`'s existing `realtime-client.test.ts` must pass
  unchanged after the `apply` refactor — proves no behavior change for
  current consumers.
- `tsc --noEmit` across the new package and example.
- Manual SSE check: a raw fetch-stream reader hitting `/api/realtime`,
  asserting an event arrives after a write — same pattern
  `crud-broadcast.test.ts` already uses at the framework level.
- Re-run `stress-seed` against `twitter-db-tanstack`'s db to confirm
  pagination and joins stay bounded under the same ~25k-post load already
  validated for `twitter-tanstack` — not just "looks fine with 20 posts."

## Explicitly out of scope (this round)

- ElectricSQL or any other TanStack DB sync source — query-collection only.
- Zod schema validation / `drizzle-zod` bridging.
- Manual dark-mode toggle UI.
- Migrating `twitter-tanstack` itself to either of these — it stays as the
  react-query/oat baseline for comparison.
