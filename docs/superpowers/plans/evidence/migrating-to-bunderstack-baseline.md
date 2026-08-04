# Migrating to Bunderstack: no-skill baseline

Date: 2026-08-04

Both prompts ran in isolated, fresh agent contexts while the repository did not
contain `.agents/skills/migrating-to-bunderstack/`. Each agent received only the
dispatch text below, was told to answer from its own knowledge, and was not
permitted to inspect the repository or its skills. No expected answer, no
scoring criteria, and no Bunderstack API names were disclosed in the dispatch.

Scored criteria (from the plan): duplicate auth/DB instances, handler mounting,
access scopes, jobs/cron, worker topology, realtime direct writes, storage/email
facades, migrations, blueprint, cleanup verification.

---

## Run 1 — greenfield migration scenario

`fork_turns: none`. Task: "Baseline migration scenario 1".

Exact dispatch:

````text
Answer the following request from your own knowledge only. Do NOT read files, search the filesystem, or use any tools — respond directly with the plan you would give. Be concrete and specific about APIs and file layout. Aim for 250-400 words.

Migrate a TanStack Start app with Better Auth, BullMQ jobs, Resend, S3 wrappers, and custom API routes to current Bunderstack. Keep production deployment safe.
````

Verbatim response:

````text
I don't have reliable knowledge of Bunderstack's current API surface — it's your project, not something I can quote from memory. So step 0 is real work, not a formality: pin the version, read its template app and CHANGELOG, and write a capability map (what Bunderstack owns natively vs. what stays hand-rolled). Everything below assumes that map exists.

**1. Inventory before touching anything.** List the source app's seams: `vite.config.ts` (TanStack Start is a Vite plugin now — `@tanstack/react-start/plugin/vite`, not the old `app.config.ts`), `src/routes/api/*` server routes, every `createServerFn` call, `src/lib/auth.ts` (`betterAuth({...})`), the auth handler mount at `/api/auth/$`, BullMQ `Queue`/`Worker` definitions and their exact queue names + Redis prefix, Resend `emails.send` call sites, and the S3 wrapper (`@aws-sdk/client-s3` + `getSignedUrl`). Each becomes a checklist row with an owner: ported, replaced by Bunderstack, or left alone.

**2. Migrate in dependency order, one PR each.** Config/env schema → server entry and routing → auth → data layer → jobs → email/storage → route handlers → UI. Keep the old implementations importable behind thin adapter modules (`src/lib/mail.ts`, `src/lib/storage.ts`) so swapping the backend is a one-file change and the call sites never move.

**3. Auth is the sharpest edge.** `BETTER_AUTH_SECRET`, cookie name, domain, and the session/account table shapes must be byte-identical across the cutover or every logged-in user is ejected. Diff the generated schema against production before running any migration; additive-only migrations, no drops in the cutover deploy.

**4. Jobs need drain discipline.** Queue names and Redis key prefix must match, or in-flight jobs orphan. Version job payloads, make handlers idempotent, and cut over by: stop enqueueing on old → let old workers drain to zero → start new workers on the same queues.

**5. Deploy safely.** Long-lived branch, staging with a production-shaped Redis/Postgres/S3, then a parallel deploy taking a small traffic slice or an internal-only hostname. Expand/contract on the DB (add columns, backfill, switch reads, drop later — never in one release). Keep the old deployment warm and revertible for at least a full traffic cycle, and verify rollback actually works before you need it.
````

Score:

| Criterion | Result | Evidence in the response |
| --- | --- | --- |
| Duplicate auth/DB instances | Fail | Auth is discussed only as secret/cookie/table continuity. Dual-instance risk is never named. |
| Handler mounting | Fail | No single-handler decision. Routing is listed as a migration step with no target contract. |
| Access scopes | Fail | Not mentioned. |
| Jobs/cron | Fail | Keeps BullMQ queue semantics; no declarative job or cron definition. |
| Worker topology | Fail | "start new workers on the same queues" retains external BullMQ workers; no app-owned worker process. |
| Realtime direct writes | Fail | Not mentioned. |
| Storage/email facades | Fail | Explicitly the opposite: "Keep the old implementations importable behind thin adapter modules (`src/lib/mail.ts`, `src/lib/storage.ts`)". |
| Migrations | Partial | Sound expand/contract and additive-only discipline, but no committed-migration contract. |
| Blueprint | Fail | Not mentioned. |
| Cleanup verification | Fail | Adapter modules are proposed as the end state, so no deletion gate exists. |

Result: 0/10 pass, 1 partial.

---

## Run 2 — layout review scenario

`fork_turns: none`. Task: "Baseline migration scenario 2".

Exact dispatch:

````text
Answer the following request from your own knowledge only. Do NOT read files, search the filesystem, or use any tools — respond directly with your review. Be concrete and specific about APIs and file layout. Aim for 250-400 words.

Review this large Bunderstack migration layout. Decide which compatibility wrappers must be removed and whether the worker belongs in the web entry.

```
src/
  bunderstack/
    index.ts        # export const app = await createApp(); await provision(app); await app.startWorker()
    auth.ts         # authConfig passed to createBunderstack
    db.ts
    env.ts
    access.ts
    schema/
    trpc/
    jobs/
  lib/
    db/index.ts     # re-exports a drizzle instance, and also constructs its own libsql client
    auth/index.ts   # a second Better Auth instance used by some server routes
    env.ts          # @t3-oss/env-core createEnv()
    s3/client.ts    # AWS SDK wrapper
    resend.ts       # Resend SDK wrapper
    queue.ts        # BullMQ queue + worker bootstrap
  routes/
    api/
      $.ts              # ALL -> app.handler(request)
      auth/$.ts         # separate Better Auth mount
      trpc/$.ts         # separate tRPC mount
      cron/cleanup.ts   # protected by a CRON_SECRET header
      resumes/upload.ts # custom multipart upload calling lib/s3
package.json            # no bunderstack.entry field; deploy runs `bun run start` only
```
````

Verbatim response:

````text
## Wrappers that must go

**`src/lib/auth/index.ts` — delete first.** Two Better Auth instances means two adapter/secret/plugin configurations over one user table. Sessions signed by one validate inconsistently in the other, and `authConfig` changes in `bunderstack/auth.ts` silently don't apply to routes using the second instance. Server routes should import the instance off the app (`app.auth`) or from `bunderstack/auth.ts`.

**`src/routes/api/auth/$.ts` and `src/routes/api/trpc/$.ts` — delete.** These are the mechanism by which the split-brain actually bites: file-based routing gives the more specific segment priority, so these shadow `routes/api/$.ts` and route every real auth/tRPC request to the legacy instances. The catch-all `ALL -> app.handler(request)` already serves `/api/auth/*` and `/api/trpc/*`.

**`src/lib/db/index.ts` — delete or reduce to a re-export.** Constructing its own libsql client opens a second connection pool that doesn't participate in `provision()`, migration state, or request-scoped transactions. If call sites are numerous, make it `export { db } from "~/bunderstack/db"` as a one-release shim, then remove.

**`src/lib/queue.ts` — delete.** A BullMQ worker bootstrap alongside `app.startWorker()` and `bunderstack/jobs/` gives you two consumers on overlapping queues: duplicate job execution, or jobs silently handled by the wrapper that never reach `jobs/`.

**`src/lib/env.ts` — collapse into `bunderstack/env.ts`.** Two `createEnv()` schemas drift; validation passes in one and throws in the other.

`lib/s3/client.ts`, `lib/resend.ts`, `routes/api/resumes/upload.ts`, and `cron/cleanup.ts` are not compatibility shims — keep them, but repoint s3/resend at the app's storage/email config if you're adopting those, and move `cleanup` into `bunderstack/jobs/` as a scheduled job so `CRON_SECRET` stops being the only auth boundary.

## The worker

It does not belong in the web entry. `src/bunderstack/index.ts` runs `provision(app)` and `startWorker()` at module scope, and `routes/api/$.ts` imports that module — so every web replica migrates the DB on boot and runs a worker. Under any horizontal scaling that's concurrent migrations plus N competing workers.

Split it: `index.ts` exports the app only; add a worker entry that imports the app and calls `startWorker()`; run `provision` as a deploy step, not at import. This is blocked until `package.json` gains a `bunderstack.entry` field and a second process command — `bun run start` alone can't run both, which is why the worker got wedged into the web entry. Fix the entry/process config before removing `startWorker()`, or background jobs stop.
````

Score:

| Criterion | Result | Evidence in the response |
| --- | --- | --- |
| Duplicate auth/DB instances | Pass | Both named precisely: second Better Auth instance "delete first", `lib/db/index.ts` "opens a second connection pool". |
| Handler mounting | Partial | Correctly deletes the shadowing `auth/$.ts` and `trpc/$.ts` in favour of the catch-all, but keeps the hand-written `ALL -> app.handler(request)` map and never reaches `createApiHandlers(app)`. |
| Access scopes | Fail | Not mentioned; `resumes/upload.ts` is kept without any resource rule discussion. |
| Jobs/cron | Pass | Moves `cron/cleanup.ts` into a scheduled job "so `CRON_SECRET` stops being the only auth boundary", and deletes the BullMQ bootstrap. |
| Worker topology | Partial | Right shape — worker out of the web entry into its own entry — but prescribes `startWorker()` for that process and never reaches `runWorker()` or its realtime-transport requirement. |
| Realtime direct writes | Fail | Not mentioned. |
| Storage/email facades | Fail | Wrong call: "`lib/s3/client.ts`, `lib/resend.ts` ... are not compatibility shims — keep them". These are exactly the wrappers the storage and email facades replace. |
| Migrations | Partial | Correctly moves `provision` out of module scope to a deploy step, but no committed Drizzle migration contract. |
| Blueprint | Partial | Notices the missing `bunderstack.entry` field, but frames it only as a process-config blocker, not as the deployment blueprint contract with a check command. |
| Cleanup verification | Pass | Real deletion gates: one-release re-export shim before removal, and "Fix the entry/process config before removing `startWorker()`, or background jobs stop". |

Result: 3/10 pass, 4 partial.

---

## Baseline conclusion

Run 1 shows that without repository guidance an agent does not know the
Bunderstack contract at all and defaults to keeping legacy SDK wrappers behind
adapter modules — the exact anti-pattern the migration is meant to remove.

Run 2 shows that strong general reasoning does recover dual-instance detection,
cron conversion, worker-out-of-web-entry, and deletion gates. It still misses
every current API name (`createApiHandlers`, `runWorker`, typed realtime
publish), treats the storage and email SDK wrappers as keepers, and does not
reach access scopes, committed migrations, or the blueprint check.

The gap the skill must close is therefore specific: current runtime contracts,
the storage/email facade replacement, access scopes, and the
migrations-plus-blueprint production gate — not general migration discipline.

The new migration-skill contract test is intentionally RED until
`.agents/skills/migrating-to-bunderstack/` provides that guidance.
