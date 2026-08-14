# Bunderstack 0.15.x → 0.16.0 — what changed and how to adapt

**Audience:** an agent or developer adapting a codebase that depends on
`bunderstack`, with no prior context on why these changes happened. Self-contained.

**Two consumer types this affects differently:**

- **Applications** built on bunderstack (`createBunderstack({ … })`) — see
  _Application migration_ below.
- **Bunderhost**, the hosting platform that deploys those applications — see
  _Platform migration_. Its changes are larger, because an entire dispatch
  mechanism it owned no longer exists.

---

## The one-paragraph summary

Bunderstack had two separate implementations of "run this once, reliably, with a
lease": a queue backed by `_bunderstack_jobs`, and cron backed by
`_bunderstack_cron_runs`. They had diverged, with cron the poorer of the two — a
throwing cron handler was never retried. 0.16.0 collapses them: **a cron
occurrence is now an ordinary job row whose dedupe key is its minute slot**,
reusing the `unique(type, dedupeKey)` constraint that already existed for
exactly-once ownership across processes. Cron inherits retries, timeouts and
failure hooks for free, and roughly 470 lines of duplicated machinery are
deleted — including the HMAC-signed HTTP endpoint the platform used to dispatch
individual cron slots.

Alongside it, **process topology became a deployment concern**: a
`BUNDERSTACK_ROLE` environment variable decides whether a process serves HTTP,
runs background work, or both. Applications no longer start workers in code.

A third, unrelated addition: a **`routes` config option** for mounting custom
Hono endpoints inside the app.

---

# Application migration

## 1. Database migration — required

`_bunderstack_cron_runs` is dropped. Regenerate and apply:

```bash
bun run db:generate   # drizzle-kit generate
```

Then apply the migration however the app normally does. In-flight rows in that
table are discarded; this is safe because cron slots are recomputed from the
schedule on the next tick.

No other schema change. `_bunderstack_jobs` is untouched.

## 2. Remove your worker process

**Before** — a separate entry file and script:

```ts
// src/worker.ts
import { app } from './bunderstack'
await app.runWorker()
```

```json
{ "scripts": { "worker": "bun src/worker.ts" } }
```

**After** — delete both. Background work starts automatically in-process.
Deploying the app is the whole deployment.

To split roles across processes, set an environment variable — no code change:

| `BUNDERSTACK_ROLE` | Serves HTTP | Runs background work |
| ------------------ | ----------- | -------------------- |
| `all` _(default)_  | yes         | yes                  |
| `web`              | yes         | no                   |
| `worker`           | no          | yes                  |

`app.startWorker()` and `app.runWorker()` still exist as escape hatches.
`app.backgroundRunning` reports whether this process runs the loop.
`background: { autoStart: false }` suppresses it — use this in tests.

## 3. Remove `app.startCronScheduler()`

Deleted. It existed only to run cron locally in development; cron now runs
through the same loop everywhere, so there is no dev/prod split to bridge.

```ts
// DELETE these lines wherever they appear
const scheduler = await app.startCronScheduler()
await scheduler.close()
```

## 4. Remove `BUNDERSTACK_CRON_SECRET`

The environment variable is gone, along with the endpoints it protected. Remove
it from `.env` files, deployment configs, secret stores, and CI.

## 5. `bunderstack/cron` exports changed

```ts
// BEFORE — these no longer exist
import { signScheduleRequest, verifyScheduleRequest } from 'bunderstack/cron'

// AFTER
import {
  parseCron,
  cronMatches,
  slotsDue,
  floorSlot,
  CRON_PREFIX,
  SLOT_MS,
} from 'bunderstack/cron'
```

## 6. `envSource` → `processEnv`

```ts
// BEFORE
createBunderstack({ envSource: { DATABASE_URL: '…' } })

// AFTER
createBunderstack({ processEnv: { DATABASE_URL: '…' } })
```

`processEnv` is a single stand-in for `process.env` feeding both env validation
and platform overrides — it replaces what were three separate injection points.

## 7. `jobs.tick()` now returns a result

```ts
// BEFORE: Promise<void>
// AFTER:  Promise<{ claimed: number; ran: number; failed: number }>
const { claimed, ran, failed } = await app.jobs.tick()
```

Only breaking if you have a **mock** of the jobs facade typed as returning
`void`. Update it to return `{ claimed: 0, ran: 0, failed: 0 }`.

## 8. Two new startup errors to be aware of

- A queue job named with the `cron:` prefix now throws — the prefix is reserved.
- `concurrency` on a cron definition now throws; cron slots are already unique.

## 9. New capabilities worth adopting

**Cron finally retries.** Previously a throwing cron handler failed permanently.
Now cron definitions accept the same options as queue jobs:

```ts
weeklyDigest: j.cron({
  schedule: '0 9 * * 1',
  retries: 3,
  timeout: 120_000,
  catchUp: 'latest', // or 'all'
  catchUpWindow: 3_600_000, // how far back catch-up looks
  onFailed: async (invocation, error, ctx) => {},
  handler: async ({ scheduledFor }, ctx) => {},
})
```

`catchUp: 'latest'` (default) runs only the most recent missed slot after
downtime. `'all'` runs every missed slot, bounded by `catchUpWindow` (default
one hour). A newly declared cron never backfills from the past.

**Custom Hono routes.** If the app currently wraps bunderstack from outside to
add a webhook — creating a second entry point and bypassing rate limiting —
replace that with the `routes` option:

```ts
// BEFORE: an external wrapper, typically with `as any` casts and a
// `router.all('*', c => app.handler(c.req.raw))` fallthrough.

// AFTER
createBunderstack({
  schema,
  routes: (ctx) => {
    const r = new Hono()
    r.post('/webhooks/telegram', async (c) => {
      const raw = await c.req.text() // raw body intact for HMAC
      await ctx.jobs.enqueue('processMessage', { raw })
      return c.json({ ok: true })
    })
    return r
  },
})
```

The context carries `db`, `env`, `storage`, `email`, `jobs`, `realtime`, `auth`,
and lazy `getSession(request)` / `getUser(request)`. Types come from your schema
and env config, so the casts disappear. `app.handler` stays the single entry
point, and the routes are rate limited because they sit inside the app.

Routes are **public by default** — no implicit auth. Paths colliding with
`/health`, `/api/health`, `/api/realtime`, `/api/auth/*`, `/api/trpc/*`,
`/api/files/*`, `/files/*`, or `/api/<enabledTableName>` throw at startup.

## Application migration checklist

- [ ] `bun run db:generate` and apply the migration dropping `_bunderstack_cron_runs`
- [ ] Delete `src/worker.ts` and the `worker` package script
- [ ] Delete `app.startCronScheduler()` calls
- [ ] Remove `BUNDERSTACK_CRON_SECRET` from env files, deploy config, secrets, CI
- [ ] Replace `envSource` with `processEnv`
- [ ] Fix any `bunderstack/cron` imports of the signing helpers
- [ ] Update jobs-facade mocks for `tick()`'s return type
- [ ] Verify no job is named with a `cron:` prefix and no cron sets `concurrency`
- [ ] Optionally: add `retries` / `onFailed` to cron definitions that need them
- [ ] Optionally: migrate an external Hono wrapper to the `routes` option
- [ ] Run `tsc --noEmit` — `bun test` does **not** typecheck and will not catch these

---

# Platform migration (Bunderhost)

The platform's cron responsibilities are gone. This is a net deletion.

## What no longer exists

- `POST /api/_bunderstack/cron/:name` — the signed per-cron dispatch endpoint
- `POST /api/_bunderstack/maintenance/storage-sweep` — the storage sweep is now
  an ordinary registered cron named `bunderstack:storage-sweep`
- `BUNDERSTACK_CRON_SECRET` — no longer injected, no longer validated
- HMAC signing of `(taskId, slot)` — `signScheduleRequest` is deleted

**Do not** keep dispatching to those endpoints; they 404.

## What replaces it

Nothing, for an always-on deployment. The application materializes its own due
cron slots on every tick, so a running process needs no external clock.

The scheduler that reconciled manifest schedules into per-minute dispatches can
be **deleted**, not rewritten.

## What to add

Set `BUNDERSTACK_ROLE` per deployed process:

- Single-machine app → `all` (or leave unset)
- Split deployment → `web` on the HTTP machines, `worker` on the background machine

Same image, same entry point, same source revision — only the variable differs.
The application no longer needs a worker-specific entry file, so a worker
deployment is the same artifact with a different env var.

## Manifest

`app.manifest.background` still reports declared cron schedules and queue jobs.
They remain useful for display and validation, but the platform **no longer
needs them to dispatch anything**. The storage sweep now appears in that list as
`bunderstack:storage-sweep` with schedule `0 4 * * *` — expect it in manifest
snapshots and update any exact-match assertions.

## Not in this release: scale-to-zero workers

A worker with no HTTP service cannot be woken by a proxy, so it must currently
run always-on. An HTTP tick endpoint that would let a worker sleep and be woken
by a content-free ping is **designed but deliberately deferred** — see the
"Phase 2" section of
`docs/superpowers/specs/2026-08-07-background-runtime-collapse-design.md`.

The relevant property, if you plan around it: after the collapse the wake signal
**carries no information**. The worker derives what is owed from the database,
so a wake ping can be lost, duplicated, delayed, or reordered without affecting
correctness. That is what will make scale-to-zero safe when it lands.

## Platform migration checklist

- [ ] Delete the cron reconciler / dispatch scheduler
- [ ] Stop injecting and validating `BUNDERSTACK_CRON_SECRET`
- [ ] Remove HMAC signing of cron requests
- [ ] Set `BUNDERSTACK_ROLE` on deployed machines (`all`, or `web` + `worker`)
- [ ] Drop the assumption that a worker deployment needs a distinct entry point
- [ ] Update manifest assertions for `bunderstack:storage-sweep`
- [ ] Ensure app deploys run the drizzle migration dropping `_bunderstack_cron_runs`

---

## Reference

Full detail lives in the repository:

- `packages/bunderstack/CHANGELOG.md` — the 0.16.0 entry
- `docs/superpowers/specs/2026-08-07-background-runtime-collapse-design.md`
- `docs/superpowers/specs/2026-08-07-custom-hono-routes-design.md`
- `website/content/docs/background-jobs.mdx` — user-facing job/cron docs
- `website/content/docs/custom-routes.mdx` — user-facing routes docs

## One caveat when verifying a migration

`bun test` does **not** typecheck. During this release four type errors survived
two green test runs, one of which was a published entry point importing a
deleted module — broken at runtime, invisible to the suite. Run `tsc --noEmit`
(now wired as `bun run typecheck` in `packages/bunderstack`) before trusting a
passing test run.
