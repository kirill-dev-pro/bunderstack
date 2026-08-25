# Changelog

All notable changes to `bunderstack` will be documented in this file.

## [0.21.0] - 2026-08-25

### Changed

- **Consolidated package architecture.** Merged `bunderstack-client`,
  `bunderstack-query`, `bunderstack-sync`, and `bunderstack-start` into the single
  `bunderstack` npm package. Consumers now install only `bunderstack` and import
  modules via clean subpath exports:
  - `bunderstack/client` (core RPC client & framework-neutral `LiveView`)
  - `bunderstack/client/rest` (type-safe REST client)
  - `bunderstack/client/react`, `bunderstack/client/solid`, `bunderstack/client/svelte`, `bunderstack/client/vue` (UI framework live view bindings)
  - `bunderstack/query` & `bunderstack/query/react` (TanStack Query client and hooks)
  - `bunderstack/sync` (TanStack DB client with realtime collections)
  - `bunderstack/start` & `bunderstack/start/auth` (TanStack Start full-stack integration)
- Framework integrations (`react`, `solid-js`, `vue`, `@tanstack/react-query`,
  `@tanstack/react-start`, `@tanstack/db`, etc.) and database drivers remain
  optional peer dependencies.

## [0.20.0] - 2026-08-25

### Added

- **Framework-neutral typed client.** The new `bunderstack-client` package
  exposes `createClient<App>()`, confirmed realtime `LiveView`, and thin Solid,
  React, Vue, and Svelte adapters. TanStack Query and TanStack DB integrations
  reuse the same transport and realtime primitives.
- **Confirmed mutation correlation.** CRUD writes propagate an opaque
  `operationId` into live-view frames. Reconnect snapshots settle successful
  writes whose delta was lost, and a heartbeat watchdog reconnects silent
  streams.

### Changed

- **Direct oRPC CRUD inputs.** Update procedures now accept
  `{ id, ...changes }`; REST keeps `PATCH /api/{table}/{id}` and rejects an
  immutable `id` in the body. Live frames preserve the table row type.
- **Optional REST artifact.** OpenAPI route-map generation is now the fallback
  for separate frontend repositories and deliberately excludes Better Auth
  routes, which continue to use the official Better Auth client.

## [0.19.2] - 2026-08-24

### Added

- **Solid and Bun SSR application support in deployment blueprint.** The
  `bunderstack blueprint` generator and contract schema now support
  standalone Solid 2, Bun SSR, and custom full-stack setups without requiring
  `@tanstack/react-start`. The generator automatically infers the framework from
  declared dependencies.

## [0.19.1] - 2026-08-23

### Fixed

- **Inline source maps in published packages.** `tsconfig.build.json` enables
  `inlineSources: true` across all packages, embedding TypeScript source code
  into `.js.map` files. This prevents bundlers and dev servers (like Vite) from
  emitting warnings about missing source files when consuming packages whose
  `src/` directory is omitted from npm tarballs.

## [0.19.0] - 2026-08-23

### Added

- **Live views.** `GET /api/live/{table}` streams one list query: a snapshot of
  the result, then only the changes that belong to it. The server evaluates the
  view's filters per record and places each row (`afterId`), so a client keeps
  the view current without a cache, without invalidation, and without repeating
  the sort. Every connection opens with a snapshot, which makes a reconnect its
  own resynchronisation. The new `bunderstack/live` subpath holds a
  dependency-free browser client (`createLiveView`) built on `subscribe` plus
  `getRows`. Reading a live view needs the table's `list` right, which also
  gates every delivered change.

## [0.18.0] - 2026-08-20

### Fixed

- **A realtime stream that dies without closing is now detected.** A connection
  killed by a proxy idle-timeout, a sleeping laptop, a NAT rebind, or a phone
  moving between networks left the client's `for await` suspended forever: it
  neither resolved nor threw, so the retry loop below it never ran and the
  client stayed silently stale until a reload. The server already sent a
  heartbeat every five seconds and the client discarded it. The heartbeat now
  advertises its interval, and the client tears the connection down after 2.5
  intervals of silence and reconnects.
- `RPCHandler` no longer receives `customErrorResponseBodyEncoder`, which is not
  part of `RPCHandlerOptions`. The option was ignored at runtime and failed the
  build. Unhandled procedure errors are still logged by `mapBunderstackErrors`
  for every transport, now covered by a test.

### Added

- **`notifyScheduler` on `syncRealtime`** — `'frame'` (default), `'sync'`, or a
  millisecond debounce. Changes are buffered and reach the cache in one flush,
  with invalidations deduplicated by query-key hash: a burst of fifty changes to
  one table used to issue fifty `invalidateQueries` calls and now issues one.
- **`apply: 'patch'` on `syncRealtime`** — writes changes into cached list
  results instead of invalidating them, so a write costs one request instead of
  two. A list is patched only when its membership and ordering can be settled
  locally, and invalidated otherwise.
- `RealtimeHeartbeat` carries `intervalMs`, so a client sizes its own
  dead-stream timeout from the server's real setting.

### Changed

- **Realtime cache writes are batched by default.** `notifyScheduler` defaults
  to `'frame'`, so an event no longer reaches the cache in the same tick it
  arrives. Applications that depended on the synchronous write can pass
  `'sync'`.
- Connection lifecycle and flush pacing moved into their own modules inside
  `bunderstack-query`. The public API is unchanged.
- Documented the provider-neutral production container contract and
  Bunderhost's custom Dockerfile convention.

## [0.17.1] - 2026-08-13

### Added

- Every configured email is recorded in internal journal tables, including
  captured, sent, failed, and provider-updated delivery states.
- Bunderhost can supply a managed Resend provider and sender at runtime.
- Resend messages carry stable email and environment tags for webhook
  correlation across production and preview deployments.

## [0.17.0-beta.4] - 2026-08-12

### Added

- **`auth` accepts a builder** — `auth: ({ db, env }) => BetterAuthConfig`, alongside the existing plain-object form. `db` is the app's own connection, typed from `schema` alone, so better-auth database hooks can live in their own file without importing the app they help type — the same reason `api`, `jobs`, and `routes` take builders. Applications no longer need a second drizzle instance just to give auth hooks a database. Exported `AuthConfigContext`, `AuthConfigInput`, `AuthConfigFactory`, and `resolveAuthConfig`.

## [0.17.0-beta.3] - 2026-08-12

### Breaking

- **The package publishes built `dist`, not raw `src`.** Every entry point now
  resolves to `dist/<entry>.js` with `dist/<entry>.d.ts` beside it, and the
  tarball no longer contains TypeScript sources. Consumers therefore typecheck
  our _declarations_, which `skipLibCheck` can suppress — previously our sources
  were compiled under the app's own flags, where `exactOptionalPropertyTypes`
  alone produced 168 errors inside `node_modules` and
  `noPropertyAccessFromIndexSignature` another 79. A strict app now sees zero
  (`bun run verify:consumer` packs, installs, and proves it).
- **`createAuth` returns better-auth's plain `Auth`** instead of the
  plugin-parameterised instance type. The value is unchanged; only the declared
  type is narrower, because the inferred one did not survive declaration emit.
  Plugin endpoints are still reachable through runtime checks.
- **Relative imports inside the published JS and declarations carry `.js`
  extensions**, so the build no longer depends on bundler-style resolution.

### Fixed

- **Generated CRUD types survive publishing.** Declaration emit inlined
  drizzle-valibot's internal generics (`TRefinements`, `TType`) into the
  published `.d.ts`, where they are unbound — a `notNull` column silently became
  optional for consumers. `select`, `update`, and `list` schemas now state their
  types explicitly, which also makes the emitted API dramatically smaller.
- `lookupIdempotency` no longer takes an unused config parameter, and
  `Bun.Image` is typed locally so image transforms compile against any
  `bun-types` version and report a clear error on an older Bun.

### Added

- `bun run build` (and `prepare`/`prepack`) build every package;
  `scripts/build-package.ts` fails the build if an emitted import resolves to
  nothing.
- `bun run verify:consumer` — packs the tarballs, installs them into a scratch
  app with the strictest common flags and `skipLibCheck: false`, then typechecks
  and smoke-runs it.
- `noUnusedParameters` and `noImplicitReturns` are on in every package.
- The tarball now includes `CHANGELOG.md`, and the README links to the migration
  guides with absolute URLs so they are reachable from an installed package.

## [0.17.0-beta.2] - 2026-08-12

Migration guide: [docs/MIGRATION-0.17.md](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.17.md).

### Breaking

- **Generated `list` takes a typed, nested `filters` object.** Filter, sort, and
  paging parameters are now declared by a per-table schema derived from the
  table's columns and its `access` allowlists, and query strings are coerced to
  those types by oRPC's `SmartCoercionHandlerPlugin`. `?filters[authorId]=u1`
  replaces `?authorId=u1`, `?filters[id][]=a&filters[id][]=b` replaces the
  comma-separated `?id=a,b`, and a bare query param is now a 400 instead of a
  silent filter. On the client, `filters` autocompletes to real columns and
  rejects wrong value types at compile time.
- **Error codes are oRPC's own codes.** `VALIDATION_ERROR` → `BAD_REQUEST`,
  `RATE_LIMITED` → `TOO_MANY_REQUESTS`. `BUNDERSTACK_ERROR_STATUS_MAP` is
  removed along with the handlers' `errorStatusMap` override.
- **Realtime events and subscriptions name tables by schema key**, not SQL table
  name, so one name works for procedures, subscriptions, and events. Only
  affects apps whose schema key differs from the table name.
- **`ScopedCollectionOptions.filter` → `filters`** in `bunderstack-sync`, and
  `table.list(input)` forwards its input to the procedure unchanged.
- **`filterableColumns` / `sortableColumns` no longer reject** column names like
  `limit` or `sort`; nesting removed the collision that made the rule necessary.

### Fixed

- **Client errors answer 4xx instead of 500.** Because the custom status map had
  no entry for oRPC's own codes, every schema failure and every rate-limit
  rejection answered HTTP 500 with a 4xx code in the body — on both REST and
  RPC. Validation responses now also carry `details` naming the failing field.
- **REST list parameters work.** `?offset=` and `?count=` failed validation
  because only `limit` was coerced from its query string; numeric, boolean, and
  date filters had no way through at all.
- **`operations.list` no longer reads the raw request URL.** The validated input
  is the only source, so a query param can no longer bypass the procedure schema
  and reach the WHERE clause.
- **Realtime updates reach sync collections** for tables whose schema key is not
  the SQL name; they previously degraded to refetch-only.
- **Packages compile under a consumer's `noUnusedLocals`.** Type-probe files are
  excluded from the tarball, unused imports are gone, and every package builds
  with the flag on so this cannot rot again (`scripts/packaging-contract.test.ts`).

### Added

- **`ApiContext` is exported**, so shared middleware can be declared as
  `os.$context<ApiContext<typeof schema>>()` instead of over a hand-written
  minimal context.
- `@orpc/json-schema` as a direct dependency (query/body coercion plugin).

## [0.17.0-beta.0] - 2026-08-11

The oRPC-first redesign: one procedure graph for CRUD, storage, realtime, and
custom procedures, served as RPC at `/api/rpc/*` and REST/OpenAPI at `/api/*`.

### Breaking

- **tRPC is replaced by oRPC.** `trpc:` → `api:`, `.query()`/`.mutation()` →
  `.handler()`, `ctx` → `context`. `@trpc/server` is no longer a dependency.
- **Validation is Standard Schema** (valibot in the box; zod and arktype work,
  with valibot the only vendor the bundled OpenAPI generator can convert).
- **Realtime runs on oRPC Publisher** as an event-iterator procedure at
  `/api/realtime`, with heartbeats and `Last-Event-ID` resume; the previous
  in-house broker is gone.
- **Storage and CRUD are procedures**, not bespoke Hono handlers.
- **`bunderstack-query` exposes oRPC's TanStack Query utilities.**
  `queryOptions(input, opts)` → `queryOptions({ input, ...opts })`,
  `keys.all` → `key()`; `listQuery`/`getQuery` are gone.

## [0.16.0] - 2026-08-07

### Breaking

- **Cron collapsed into the jobs table.** A cron occurrence is now an ordinary queue job with `type = 'cron:<name>'`, `runAt = <slot>`, and `dedupeKey = String(slot)`, reusing the existing `unique(type, dedupeKey)` constraint for exactly-once slot ownership. The `_bunderstack_cron_runs` table is dropped — **run `drizzle-kit generate` and apply the migration**.
- **Removed `app.startCronScheduler()`.** Cron runs through the same tick everywhere, so the development/production split no longer exists.
- **Removed the signed cron endpoints** `POST /api/_bunderstack/cron/:name` and `POST /api/_bunderstack/maintenance/:name`, along with `signScheduleRequest` / `verifyScheduleRequest` and the `BUNDERSTACK_CRON_SECRET` environment variable. Platforms no longer dispatch individual cron slots.
- **`bunderstack/cron` export changed.** It no longer re-exports the signing helpers; it now exports `parseCron`, `cronMatches`, `slotsDue`, `floorSlot`, `CRON_PREFIX`, and `SLOT_MS`.
- **`JobsRuntimeFacade.tick()` returns `TickResult`** (`{ claimed, ran, failed }`) instead of `void`.
- **Queue job names may not begin with `cron:`** — the prefix is reserved and rejected at startup.
- **`concurrency` is rejected on cron definitions** at startup; cron slots are already unique.
- **Removed the `envSource` config option**, replaced by `processEnv` (see below).

### Added

- **`BUNDERSTACK_ROLE`** (`all` | `web` | `worker`, default `all`) makes process topology a deployment concern. The background loop starts automatically when the role includes the worker; no application code calls `startWorker()`. Override with `background: { autoStart: false }`.
- **`app.backgroundRunning`** reports whether this process runs the background loop.
- **Cron definitions gained `retries`, `backoff`, `timeout`, and `onFailed`**, matching queue jobs. Previously a throwing cron handler was never retried.
- **Cron definitions gained `catchUp`** (`'latest'` default, or `'all'`) and `catchUpWindow` (default 1 hour) controlling how missed slots are handled after downtime.
- **`routes` config option** — a builder callback `(ctx) => Hono` mounting custom Hono routes at root, ahead of bunderstack's own. The context carries `db`, `env`, `storage`, `email`, `jobs`, `realtime`, `auth`, plus lazy `getSession(request)` / `getUser(request)`. Exported as `BunderstackRouteContext`.
- **`processEnv` config option** — a single stand-in for `process.env`, feeding both env validation and platform overrides. Replaces `envSource` and unifies what were three separate injection points.
- **`typecheck` script** on the package.

### Fixed

- **Terminal job updates are fenced on the held lease.** A worker whose lease expired could previously mark a row `succeeded` after another worker re-claimed and re-ran it, and could fire `onFailed` twice.
- **Retry backoff is jittered** (±20%), so jobs failed by a shared outage no longer retry in lockstep.
- **Custom routes are rate limited.** Routes mounted via `routes` sit inside the rate-limited app; the previous external-wrapper workaround left them uncovered.
- **`bunderstack/cron` no longer imports a deleted module.** The entry point was broken at runtime.
- **Succeeded-row reaping moved off the per-tick path** to at most hourly. Retention is unchanged at 24h.
- `tableEntryForName` is defined once in `access.ts` instead of copied into four modules, so CRUD, realtime, and route validation cannot disagree on which tables are enabled.

## [0.15.2] - 2026-08-05

### Fixed

- S3 uploads carry the correct content type.
- Documented the nested `node_modules` resolution issue for consumers.

## [0.15.1] - 2026-08-04

### Fixed

- Blueprint generator tests use a cross-platform temp directory; the CLI is
  marked executable.

## [0.15.0] - 2026-08-04

### Added

- **Deployment blueprints** (`bunderstack blueprint`) — static deploy metadata a
  hosting platform can read without executing application code.

## [0.13.0] - 2026-08-01

### Added

- **`StorageFacade.upload()`** for server-generated files.
- Nested file paths in the storage `GET`/`DELETE` routes.

## [0.12.0] - 2026-07-31

### Added

- **`storage` in the procedure context**, alongside `db`, `env`, and the rest.

### Fixed

- Presign fallback uses the configured default bucket.

## [0.11.0] - 2026-07-30

### Added

- **`BunderstackJobContext`** exported as a type alias for typing job handlers.

## [0.10.0] - 2026-07-28

### Added

- **Static Deployment Metadata**: Preserve cron schedule literals in the public jobs type so hosting platforms can infer deployment requirements without executing application code.

### Fixed

- **Browser Timer Compatibility**: Accept numeric timer handles in the local cron scheduler.

## [0.9.1] - 2026-07-26

### Fixed

- **npm Publish Workspace Resolution**: Automatically sanitize `workspace:*` dependency protocols to exact version specifiers (`^0.9.1`) during `npm publish` in CI/CD pipeline.

## [0.9.0] - 2026-07-26

### Added

- **Realtime Transport Metadata**: Added `realtime.transport` (`'disabled' | 'memory' | 'redis'`) to `RealtimeFacade` and `app.realtime`.
- **Manifest Transport Inspection**: Added `realtimeTransport` field to `BunderstackManifest` and `buildManifest()` for platform introspection (Bunderhost).
- **Standalone Worker Transport Safety**: `app.runWorker()` now rejects in-memory realtime brokers by default to prevent silent event loss between web and worker processes. Added `allowProcessLocalRealtime?: boolean` flag for workers that do not publish realtime events.
- Exported `RealtimeTransport` and `createRealtimeFacade` from `bunderstack`.

### Fixed

- Fixed test isolation in worker and introspection unit tests when `process.env.REDIS_URL` is set in the execution environment.

## [0.8.0] - 2026-07-25

### Added

- **Static Dependency Boundaries**: Clean separation of database, auth, email, and storage adapter boundaries.
- **JobContext & tRPC Context Realtime**: Wired generic-typed `ctx.realtime` into background job handlers and tRPC procedures.
- **DB Provisioning Internals**: Standalone `bunderstack/provision` module for database migration tooling.
