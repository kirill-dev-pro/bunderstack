# Workers runtime: bunderstack 1.0

Date: 2026-09-27
Branch: next
Package: `packages/bunderstack`

## Context

Today a bunderstack app is one Bun process. On Bunderhost it is one Fly
machine. An app that declares jobs or cron must stay on all the time, because
the process is the only thing that runs background work. The frontend is
server-rendered by the same process.

The goal is: the frontend is static, and the backend runs without machines. An
idle app then costs almost nothing.

A spike on 2026-09-27 ran a bunderstack 0.25.2 app in celld 0.6.0 (self-hosted,
Cloudflare-compatible Durable Objects). The results:

- `app.handler`, Hono, oRPC, Drizzle over libsql HTTP, and access rules worked
  with no change.
- BetterAuth sign-up and sign-in worked after two workarounds:
  `Bun.randomUUIDv7` in `typeid.ts` is not defined, and `node:crypto.scrypt`
  is not implemented in celld.
- A Durable Object scheduler that calls `app.jobs.tick()` from an alarm ran a
  queued job and a cron slot. The in-process worker loop must be off, or
  timers in a random isolate run jobs.
- The in-memory realtime broker failed: celld retired the SSE isolate after
  10 s, and the write went to a new isolate. A hub Durable Object delivered
  events across requests, with a 20 s heartbeat, for 95 s.
- Bundle: 6 MB, 1 MB gzip. Cell start: 70 to 90 ms.

celld is an alpha. One fleet runs one application, and celld is "not safe for
hostile multi-tenant use". A shared celld fleet for all Bunderhost customers is
therefore not possible.

## Product decisions

- Production always runs on the Workers API. There are two targets:
  - Cloudflare, sold by Bunderhost.
  - celld on the user's own VPS, free on Bunderhost. One fleet per app. The
    code on the VPS belongs to one owner, so the multi-tenant limit does not
    apply.
- `bun dev` stays the one local command, and it starts everything.
- The database is libsql over HTTP: Turso on Cloudflare, sqld locally, sqld or
  Turso on a VPS.
- Image transforms use one WASM implementation on all targets (stage 1b).
- Files use an R2 binding on both targets. S3 keys to the same bucket are
  optional and enable presigned uploads.
- The frontend is an SPA served by static assets. SSR is out of scope.
- The integration shape is approach A: the library exports `createWorker()`
  and Durable Object classes, and each app has a short `src/worker.ts`.
- The release is a major version, 1.0.0-beta.N, on the `next` npm tag. The
  package name is decided before the stable 1.0.

## Goals

- The core runs on the Workers API and has no Bun-only API in the request
  path, the job path, or module load.
- The core still runs under `bun test`, with an in-memory platform.
- One `wrangler.json`, generated from the blueprint, deploys to Cloudflare and
  to celld.
- `bun dev` starts sqld, celld, and Vite with one command.

## Non-goals

- SSR.
- Postgres at runtime (`bun-sql`, `postgres`). They can come back later on
  `connect()`.
- SMTP at runtime. It can come back later on `connect()`.
- Parallel job execution across isolates.
- Realtime sharding. There is one hub per app.
- The Bun process runtime as a production target.
- A multi-tenant celld fleet.

## Architecture

### Core: `bunderstack`

The core has no `Bun.*` call and no I/O at module load. It receives every
platform service through one internal interface:

```ts
interface Platform {
  jobs: { notify(runAt: number): void | Promise<void> }
  realtime: RealtimePublisher | undefined // the oRPC Publisher seam
  rateLimit: RateLimitStore
  storage: (bucket: ResolvedBucket) => StorageAdapter
}

interface RateLimitStore {
  hit(key: string, windowMs: number, max: number): Promise<{
    allowed: boolean
    resetAt: number
  }>
}
```

`backend.start({ env, platform })` builds the app. `env` already exists.
`bunderstack/testing` exports an in-memory platform:

- `jobs.notify` records the call.
- `realtime` is `MemoryPublisher`.
- `rateLimit` uses a `Map`.
- `storage` is a memory adapter.

New core API: `app.jobs.nextDueAt(now)`. It returns the earliest of:

- `run_at` of a pending job;
- `locked_until` of a running job;
- the next cron slot of each declared cron.

It returns `null` when there is no work.

Changes in the core:

- `typeid.ts`: a UUIDv7 in plain JS that stays monotonic in one millisecond.
  It replaces `Bun.randomUUIDv7`.
- `rate-limit.ts`: uses `platform.rateLimit`, not a module-level `Map`.
- `runtime.ts`: the realtime publisher comes from `platform.realtime`. The
  Redis transport, `Bun.RedisClient`, and `REDIS_URL` are removed.
- The in-process worker loop, `BUNDERSTACK_ROLE`, `startWorker()`, and
  `runWorker()` are removed. `enqueue` calls `platform.jobs.notify(runAt)`.
- Storage: the `StorageAdapter` interface stays. `Bun.S3Client` is removed.
  Presign uses SigV4 on WebCrypto when S3 keys are set. Without keys, uploads
  use proxy mode.
- `storage/thumbnails.ts`: WASM replaces `Bun.Image`. Derivatives stay cached
  in the bucket under `__transforms/`.
- Passwords: the hash format stays the BetterAuth scrypt format
  (`salt:key`, N=16384, r=16, p=1, 64-byte key). BetterAuth picks
  `node:crypto` scrypt through the `workerd` and `node` export conditions, and
  celld does not implement it. bunderstack therefore sets
  `emailAndPassword.password` to its own `hash` and `verify`. They use native
  `node:crypto` scrypt when it works, and `@noble/hashes` scrypt when it does
  not. Existing hashes stay valid, and no migration is necessary.
- `hosted-contract.ts`: `Bun.file` is replaced. The blueprint check reads
  through an injected function, or it is skipped in a Worker.
- Database adapters: `libsql` is the runtime adapter. `bun-sqlite` and
  `pglite` stay for tests only.

`node:crypto` hashing and `node:path` stay. They work in workerd with
`nodejs_compat` and in celld.

### Workers integration: `bunderstack/workers`

This is the only module that knows about Workers.

- `createWorker(backend)` returns an `ExportedHandler`.
  - The first request in an isolate calls `backend.start({ env, platform })`
    and caches the promise. If `start()` fails, the cache is cleared, so the
    next request tries again.
  - It builds `Platform` from bindings.
  - It serves `/api/*` through `app.handler`. Static assets serve all other
    paths, with SPA fallback to `index.html`.
- Durable Object classes: `Scheduler`, `RealtimeHub`, `RateLimiter`.
  `createWorker(backend)` returns `{ handler, durableObjects }`. The
  `Scheduler` needs the backend, so the classes come from this call, and the
  app exports them by name.
- Fixed binding names: `SCHEDULER`, `REALTIME`, `RATE_LIMITER`, `ASSETS`, and
  one R2 binding per storage bucket (`BUCKET_<NAME>`).
- Vars and secrets: `BUNDERSTACK_DATABASE_URL`,
  `BUNDERSTACK_DATABASE_AUTH_TOKEN`, `AUTH_SECRET`, and the optional S3 keys
  for presign.

App entry:

```ts
// src/worker.ts
import { createWorker } from 'bunderstack/workers'

import { backend } from './bunderstack'

const worker = createWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

### Jobs: `Scheduler`

There is one instance per app, with the name `main`.

- `notify(runAt)` sets the alarm to `min(current alarm, runAt)`.
- `alarm()`:
  1. Calls `app.jobs.tick(now)` again while a tick claims a full batch, until
     a time budget ends.
  2. If the alarm came from `notify` and the tick claimed nothing, it retries
     once after 1 s. This covers an enqueue in a transaction that has not
     committed yet.
  3. Sets the next alarm to `min(nextDueAt, now + 1 h)`. The cap is a safety
     net for a lost `notify`.
- Handlers run in the `Scheduler`. Leases, retries, and `onFailed` stay as
  they are.
- `wrangler.json` has `triggers.crons` with the declared cron schedules (and
  the storage sweep when there are buckets). The `scheduled` handler notifies
  the `Scheduler`, so cron runs even when the app gets no traffic. More than
  five schedules collapse to `* * * * *`. The safety cap is 1 hour, not
  5 minutes.
- The documentation gives the maximum `maxRuntime` for each target. It comes
  from the alarm limits of Cloudflare and celld.

### Realtime: `RealtimeHub`

There is one instance per app. The hub only fans out events.

- The core gets an oRPC `Publisher` that is built on the hub:
  - `publish` sends the event to the hub.
  - `subscribe` opens a stream from the hub and exposes it as an async
    iterator.
- The access filter (`filterTableChanges`) stays in the isolate that holds the
  client SSE. The hub does not know about access.
- For resume by `lastEventId`, the hub keeps a ring buffer with event ids.
  The default window is 300 s, as today.
- On the internal stream, the hub sends a heartbeat every 20 s. celld expires
  an idle stream after 60 s.
- If the hub is not available, the write still succeeds, and the publish
  error goes to the log. This is the same best-effort behavior as Redis today.

### Rate limit: `RateLimiter`

- There is one instance per key. The key is client plus path
  (`idFromName`). Each instance keeps a fixed window in memory.
- The client is `CF-Connecting-IP` on Cloudflare. On celld it is
  `X-Forwarded-For`, and only from a trusted proxy
  (`--trust-forwarded-headers`).

## Tooling

### `bunderstack wrangler`

This command generates `wrangler.json` from the blueprint:

- `main: src/worker.ts`;
- `compatibility_flags: ["nodejs_compat"]`;
- the three Durable Object bindings and their `new_sqlite_classes` migrations;
- one R2 bucket per storage bucket;
- `assets` pointing at `dist/client`, with SPA not-found handling and
  `run_worker_first` for `/api/*`.

`--check` fails when the file and the blueprint differ, the same way
`blueprint --check` does. The file uses only keys that both celld and
Cloudflare accept.

### `bunderstack dev`

This is the `dev` script, and it starts everything with one command:

1. Regenerates `wrangler.json`.
2. Starts sqld with data in `.bunderstack/dev/`. Pushes the schema, and pushes
   again when the schema changes.
3. Writes `.dev.vars` (the database URL and `AUTH_SECRET`) and starts
   `celld dev`. celld rebuilds the Worker on code change. R2 uses the local
   celld store. There are no S3 keys in dev, so uploads use proxy mode.
4. Starts Vite for the SPA with HMR, and proxies `/api` to celld.
5. Prints one log with a prefix per process. Ctrl+C stops all of them.

The celld and sqld binaries are pinned. On the first run, the CLI downloads
them to `~/.cache/bunderstack` and verifies their checksums. An environment
variable selects system binaries instead.

### `bunderstack build`

This command runs `vite build` to `dist/client` and checks `wrangler.json`.
celld and wrangler bundle the Worker with esbuild.

## Deployment

- Cloudflare through Bunderhost (paid): Workers for Platforms, with a script
  per environment and bindings for the Durable Objects, R2, assets, and
  secrets. The database is Turso per environment, as today. Bunderhost runs
  migrations before the upload. Custom domains use Cloudflare for SaaS.
- celld on the user's VPS through Bunderhost (free): the existing server
  enrollment adds celld. Each app gets a fleet: a systemd unit with its own
  ports and bucket prefix. Caddy terminates TLS and routes the domain to the
  fleet. sqld runs next to it, with bottomless backup to S3. celld stores
  production state only in an S3-compatible, GCS, or Azure bucket, so the VPS
  target needs a bucket: an external one (R2, B2, Tigris) or MinIO on the
  VPS. The same bucket holds the app files.
- Manual: `wrangler deploy` to the user's Cloudflare account,
  `celld deploy --bucket s3://…` to the user's server, or a `Dockerfile`
  template based on `ghcr.io/denoland/celld`.

## Testing

- Core: `bun test` with the in-memory platform. `backend.test()` for apps does
  not change. Tests of removed parts (Redis, the worker loop, `Bun.S3Client`,
  `Bun.Image`) are rewritten or deleted.
- Durable Object classes: unit tests with a fake `DurableObjectState` that
  keeps alarm and storage in memory.
- Integration suite: the spike scenarios on an example app. These are CRUD,
  auth, a job and a cron through the alarm, SSE through the hub, an R2 upload
  and a presign, and an image transform. The suite runs on `celld dev` and on
  `wrangler dev` (workerd), to find differences between celld and Cloudflare.
  It runs from its own script and in CI, not in the default `bun test`,
  because it downloads binaries and starts processes.

## Breaking changes for existing apps

- Add `src/worker.ts` and `wrangler.json`. Remove `server.ts`, the
  `vite preview` entry, the TanStack Start `/api/$` route, and SSR. The
  frontend becomes an SPA.
- `REDIS_URL`, `BUNDERSTACK_ROLE`, `runWorker()`, and `startWorker()` are
  removed.
- `storage.local` and the S3 backend config become an R2 binding plus optional
  S3 keys.
- Only libsql at runtime. No Postgres, no SMTP.
- Passwords do not change. On celld, sign-in uses scrypt in plain JS, at
  about 100 to 300 ms CPU.

A migration guide and an updated `migrating-to-bunderstack` skill ship with
the beta. FikFlix is the first app to migrate.

## Release

- Work happens on the `next` branch. Versions are 1.0.0-beta.N. `main` keeps
  0.25.x fixes.
- `scripts/publish-changed.ts` publishes a prerelease version with
  `--tag next`, so `latest` does not change.

## Stages

Each stage has its own implementation plan.

1. Core: `Platform` and the in-memory platform, `typeid`, rate limit store,
   injected publisher, `jobs.notify` and `nextDueAt`, removal of the worker
   loop and Redis, the S3 adapter on `fetch` with SigV4, passwords,
   `hosted-contract` without `Bun.file`.
1b. WASM image transforms. A short probe selects the library first: it must
   load in `bun test`, workerd, and celld, and it must decode and encode the
   four formats of today (`webp`, `jpeg`, `png`, `avif`).
2. `bunderstack/workers`: `createWorker`, the three Durable Objects, the R2
   adapter, `bunderstack wrangler`, and the integration suite on celld and
   workerd.
3. CLI `bunderstack dev` and `build`. The examples and the SaaS template move
   to SPA.
4. Release 1.0.0-beta.1, the migration guide, and the FikFlix migration.
5. Bunderhost: first the free celld VPS target, which does not depend on
   Workers for Platforms, then the paid Cloudflare target.

## Open questions

- Do Durable Objects work in user Workers in Workers for Platforms, and what
  do they cost? The paid Cloudflare target depends on the answer. Verify
  before stage 5.
- How does celld handle secrets in production? Its documentation shows only
  `vars` and `.dev.vars`. Verify before stage 5.
- What are the CPU and memory limits of the WASM image transform on a large
  photo? Is avif supported? Verify in stage 1b.
- What is the CPU cost of the scrypt verify in plain JS on celld? Verify in
  stage 2.
- The bunderstack API logged a 401 response as "500 Internal Server Error" in
  the spike. Check this under Bun, outside this project.
