# Changelog

All notable changes to `bunderstack` will be documented in this file.

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
