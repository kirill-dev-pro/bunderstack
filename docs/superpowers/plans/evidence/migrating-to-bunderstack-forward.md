# Migrating to Bunderstack: forward test with the skill

Date: 2026-08-04

Both runs used fresh agent contexts with `fork_turns: none` and an explicit
`$migrating-to-bunderstack` invocation. The request text after the invocation
line is byte-identical to the corresponding baseline dispatch in
`migrating-to-bunderstack-baseline.md`. Both runs received the same invocation
framing, so run 4 is controlled against run 3.

No baseline failure, expected answer, scoring criterion, or Bunderstack API name
was disclosed in either dispatch.

---

## Run 3 — greenfield migration scenario, with the skill

`fork_turns: none`. Task: "Forward migration scenario 1". Tool uses: 4.

Exact dispatch:

```text
Use $migrating-to-bunderstack, the repository skill at /Users/kirill/Projects/bunderstack-project/bunderstack/.worktrees/bunderstack-saas-template-skills/.agents/skills/migrating-to-bunderstack/. Then answer the request below. Be concrete and specific about APIs and file layout. Aim for 250-400 words.

Migrate a TanStack Start app with Better Auth, BullMQ jobs, Resend, S3 wrappers, and custom API routes to current Bunderstack. Keep production deployment safe.
```

Verbatim response:

```text
Skill loaded (SKILL.md + both references). No target app exists in this worktree, so this is the migration plan against the current contracts.

## Order (each phase leaves the app working)

**1. Inventory + gate.** Fill the audit table at `.agents/skills/migrating-to-bunderstack/references/audit-checklist.md` with evidence (command output/file refs, not assertions). Write migration contract tests *before* deleting anything — auth session, each custom route's behavior, each BullMQ job, each S3 op, each email.

**2. One entry, one schema.** Create `src/bunderstack/` with `index.ts`, `schema/`, `access.ts`, `auth.ts`, `env.ts`, `jobs/`, `trpc/`. `index.ts` is the only assembler: `createBunderstack({ schema, access, env: envSchema, database: { adapter: libsql(), url }, auth: authConfig, email, storage, realtime, jobs, trpc })`, then `export const { db, auth, env } = app` and `await provision(app)`. The adapter is explicit — no implicit driver. Aggregate every table including `export * from 'bunderstack/schema'` so migrations cover internal tables. Keep import-time side effects out; `bunderstack blueprint` imports the entry with `BUNDERSTACK_INTROSPECT=1`.

**3. Better Auth.** Export a plain `authConfig` from `auth.ts` — never a second `betterAuth()` call, custom session resolver, or patched `getSession`. `auth.ts` reads `process.env` at module scope and uses dynamic `import('./index')` inside async callbacks, or you get a circular boot loop.

**4. Routes.** Replace every hand-written `ALL: ({ request }) => app.handler(request)` map with one file: `src/routes/api/$.ts` → `createFileRoute('/api/$')({ server: { handlers: createApiHandlers(app) } })`. Delete `/api/auth/$`, `/api/trpc/$`, `/api/cron/*` — a more specific file route shadows the catch-all and keeps serving the instance you meant to remove. Custom CRUD routes become generated CRUD + `defineAccess(schema, rules)` (`ownerColumn`, `scope.read`); anything needing a related row or role becomes a protected tRPC procedure.

**5. BullMQ → jobs.** `jobs.job({ input, concurrency, timeout, handler, onFailed })`, enqueue via `app.jobs.enqueue(name, payload)`; handlers are at-least-once, so make them idempotent. Cron secrets → `jobs.cron({ schedule, handler })`.

**6. S3/Resend.** `app.storage.upload/getUrl/delete` with declared buckets; `app.email.send({ to, subject, html })` (`provider` defaults to `resend` when `RESEND_API_KEY` is set). Uninstall both SDKs in the commit removing the last importer.

## Production safety

`src/worker.ts` = `await app.runWorker()` as its own process (`bun src/worker.ts`) — never from the web entry, or every replica competes for jobs. If jobs publish realtime, web and worker need the same `REDIS_URL`; `runWorker()` refuses the in-memory broker. Publish with `ctx.realtime.publish(schema.table, 'update', fullRow)` after commit, never inside the transaction, never a partial patch. Before cutover: committed `migrations/` (no schema push), `package.json#bunderstack.entry`, `blueprint:check` green in CI. Tests/scripts building their own app must `app.close()` in `finally`.
```

Score:

| Criterion                   | Baseline | With skill | Evidence in the response                                                                                                         |
| --------------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate auth/DB instances | Fail     | Pass       | "never a second `betterAuth()` call, custom session resolver, or patched `getSession`"; "`index.ts` is the only assembler".      |
| Handler mounting            | Fail     | Pass       | "`server: { handlers: createApiHandlers(app) }`" plus deletion of the shadowing routes.                                          |
| Access scopes               | Fail     | Pass       | "generated CRUD + `defineAccess(schema, rules)` (`ownerColumn`, `scope.read`)"; related-row and role cases go to protected tRPC. |
| Jobs/cron                   | Fail     | Pass       | "`jobs.job({ input, concurrency, timeout, handler, onFailed })`", at-least-once idempotency, "Cron secrets → `jobs.cron(...)`".  |
| Worker topology             | Fail     | Pass       | "`src/worker.ts` = `await app.runWorker()` as its own process ... never from the web entry".                                     |
| Realtime direct writes      | Fail     | Pass       | "`ctx.realtime.publish(schema.table, 'update', fullRow)` after commit, never inside the transaction, never a partial patch".     |
| Storage/email facades       | Fail     | Pass       | "`app.storage.upload/getUrl/delete`"; "`app.email.send(...)`"; "Uninstall both SDKs in the commit removing the last importer."   |
| Migrations                  | Partial  | Pass       | "committed `migrations/` (no schema push)".                                                                                      |
| Blueprint                   | Fail     | Pass       | "`package.json#bunderstack.entry`, `blueprint:check` green in CI".                                                               |
| Cleanup verification        | Fail     | Pass       | "Write migration contract tests _before_ deleting anything"; audit table filled with evidence rather than assertions.            |

Result: 10/10 pass, up from 0/10 pass and 1 partial.

The baseline's actively wrong decision — keeping the Resend and S3 wrappers
behind adapter modules — is reversed: both wrappers are removed and their
packages uninstalled under a stated gate.

---

## Run 4 — layout review scenario, with the skill

`fork_turns: none`. Task: "Forward migration scenario 2". Tool uses: 4. The
invocation line is identical to run 3's; the request body is identical to
baseline run 2's.

Exact dispatch:

````text
Use $migrating-to-bunderstack, the repository skill at /Users/kirill/Projects/bunderstack-project/bunderstack/.worktrees/bunderstack-saas-template-skills/.agents/skills/migrating-to-bunderstack/. Then answer the request below. Be concrete and specific about APIs and file layout. Aim for 250-400 words.

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

```text
## Wrappers that must go

Three in `src/lib/` are the dangerous class — a second live implementation of a capability Bunderstack already owns:

- `src/lib/auth/index.ts` — a second `betterAuth()` construction splits session validation. Only `src/bunderstack/auth.ts` should exist, exporting a plain `authConfig` passed into `createBunderstack()`; consumers import `app.auth`. Note `auth.ts` must read `process.env` at module scope and use a dynamic `import('./index')` inside async callbacks, or boot deadlocks circularly.
- `src/lib/db/index.ts` — constructing its own libsql client puts it outside provisioning, migration state, and request transactions. The entry is the only place calling `libsql()`; re-export `app.db`.
- `src/lib/env.ts` — the `@t3-oss/env-core` `createEnv()` drifts from the validated schema and doesn't reach the deployment blueprint. Pass `envSchema` via `createBunderstack({ env })`, read `app.env`/`ctx.env`. Drop `dotenv` too; Bun loads `.env`.

The three SDK wrappers go under the same gate, and the package is uninstalled in the commit that removes the last importer: `src/lib/s3/client.ts` → declared buckets and `app.storage.upload/getUrl/delete`; `src/lib/resend.ts` → `app.email.send(...)` (the facade uses `fetch`, so `resend` is uninstalled); `src/lib/queue.ts` → `jobs.define({...})` plus `app.jobs.enqueue(...)`.

Routes: `routes/api/auth/$.ts` and `routes/api/trpc/$.ts` must be deleted — a more specific file route shadows the catch-all, so they silently keep serving the instance you meant to remove. `routes/api/cron/cleanup.ts` becomes `jobs.cron({ schedule, handler })` and `CRON_SECRET` leaves env. `routes/api/$.ts` stops being a hand-written `ALL` map and becomes `server: { handlers: createApiHandlers(app) }`. `routes/api/resumes/upload.ts` is replaced by the bucket's own upload route unless it does domain work that should move into a job.

## The worker

No. `src/bunderstack/index.ts` calling `await app.startWorker()` means every web replica runs a worker competing for the same jobs. Move it to `src/worker.ts` with `await app.runWorker()`, run as `bun src/worker.ts`. `runWorker()` refuses to start if jobs publish realtime over the in-memory broker — give web and worker the same `REDIS_URL`. Deploy the worker process before deleting the embedded call.

`package.json` needs `bunderstack.entry: "src/bunderstack/index.ts"`, a `worker` script, and `blueprint`/`blueprint:check` (green in CI) before cutover; `bun run start` alone is not a declared topology.
```

Score:

| Criterion                   | Baseline | With skill | Evidence in the response                                                                                                                                                           |
| --------------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate auth/DB instances | Pass     | Pass       | Both named, plus the circular-import rule the baseline did not have.                                                                                                               |
| Handler mounting            | Partial  | Pass       | Baseline kept the hand-written map; this run replaces it: "`routes/api/$.ts` stops being a hand-written `ALL` map and becomes `server: { handlers: createApiHandlers(app) }`".     |
| Access scopes               | Fail     | Not raised | Outside this prompt's question. Scored Fail at baseline on the same basis, so it is excluded from this run's delta.                                                                |
| Jobs/cron                   | Pass     | Pass       | `jobs.define`/`enqueue` for the queue wrapper; cron route converted and "`CRON_SECRET` leaves env".                                                                                |
| Worker topology             | Partial  | Pass       | Baseline prescribed `startWorker()` in a worker entry; this run reaches `app.runWorker()`, the `bun src/worker.ts` process, and the in-memory-broker refusal.                      |
| Realtime direct writes      | Fail     | Partial    | Transport rule is correct ("same `REDIS_URL`"), but typed publish is not raised — the prompt asks about wrappers and worker placement, not write paths.                            |
| Storage/email facades       | Fail     | Pass       | Reversal of the baseline's wrong call: both wrappers now "go under the same gate, and the package is uninstalled in the commit that removes the last importer".                    |
| Migrations                  | Partial  | Not raised | Outside this prompt's question; the layout shown has no migration configuration to review.                                                                                         |
| Blueprint                   | Partial  | Pass       | Baseline framed the missing field as a process blocker; this run names the contract: entry field, worker script, and "`blueprint`/`blueprint:check` (green in CI) before cutover". |
| Cleanup verification        | Pass     | Pass       | Deletion gates retained and made explicit: uninstall in the last-importer commit, "Deploy the worker process before deleting the embedded call."                                   |

Result: 7 pass, 1 partial, 2 not raised — up from 3 pass and 4 partial. No
criterion regressed.

---

## Refactor decision

No skill file changed in this round.

Both runs selected the intended layout, handler mount, worker topology, job and
cron model, facade replacements, deletion gates, and production declaration. The
two "not raised" cells in run 4 are outside what that prompt asks, not wrong
answers, and the plan forbids adding hypothetical sections for gaps that were
not observed.

The single criterion still short of Pass anywhere is typed realtime publishing
in run 4. It is already stated in `SKILL.md` and in the direct-write section of
`references/runtime-replacements.md`, and run 3 reproduces it correctly from the
same text, so the omission is prompt scope rather than a skill gap. Adding a
prohibition would violate the plan's rule that prohibitions require an observed
discipline failure.
