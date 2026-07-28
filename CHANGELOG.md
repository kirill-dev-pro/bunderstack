# Changelog

All notable changes to `bunderstack` will be documented in this file.

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
