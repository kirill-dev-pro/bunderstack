# Audit checklist

Use this table at phase 1 to record who owns each capability today, and again
at phase 7 before deleting anything. Fill the evidence column with a command
output or a file reference, not an assertion.

| Capability | Legacy shape to find | Authoritative replacement | Evidence that the move is done | Deletion gate |
| --- | --- | --- | --- | --- |
| Auth instance | A second `betterAuth({...})` call, a custom session resolver, a patched `getSession` | `authConfig` passed to `createBunderstack()`; consumers import `app.auth` | One `betterAuth` construction in the repository; a protected route rejects an unauthenticated request | No importer of the legacy auth module remains |
| Auth schema | Auth tables generated into a legacy schema directory | Auth tables in the one schema aggregate | Generated migration includes `user`, `session`, `account`, `verification` | Legacy schema directory has no importers |
| Database client | A module constructing its own libSQL/Postgres client | `app.db`, re-exported from the entry | The entry is the only place calling the adapter factory | Legacy `db` module deleted or reduced to a re-export, then deleted |
| API mounting | Hand-written handler maps; separate `/api/auth/$`, `/api/trpc/$` | `createApiHandlers(app)` on one `/api/$` | Auth and tRPC requests succeed with only the catch-all present | Shadowing route files deleted |
| Custom API routes | Route files doing CRUD the framework can generate | Generated CRUD plus `defineAccess`, or a protected tRPC procedure | Access rules cover each exposed table; a cross-owner request is denied | Route file has no client callers |
| Access control | Per-endpoint session checks and hand-written SQL filters | `defineAccess(schema, rules)` with `scope.read` / `scope.write` | A test asserts a second user cannot read or write the first user's rows | Manual filter helpers unused |
| Jobs | BullMQ or a bespoke queue module | `jobs.define({ ... })` and `app.jobs.enqueue(...)` | Job appears in `app.manifest.background.jobs` | No queue library importer; package uninstalled |
| Cron | `/api/cron/*` guarded by a shared secret | `jobs.cron({ schedule, handler })` | Cron task appears in the blueprint | Cron route file and its secret removed from env |
| Worker topology | `startWorker()` or a queue bootstrap in the web entry | `src/worker.ts` calling `app.runWorker()`, run as its own process | Web entry starts no worker; the worker command exists in deployment config | Worker process is deployed before the embedded call is removed |
| Realtime | Custom WebSocket server, manual pub/sub, channel-and-payload publishing | `realtime` config plus `ctx.realtime.publish(table, event, row)` after commit | A direct write reaches a subscriber with the complete row | Custom transport deleted; shared Redis configured for multi-process |
| Storage | AWS or Tigris SDK wrapper, custom multipart upload route | Declared buckets and `app.storage` | Upload, signed URL, and delete work through the facade | Wrapper deleted and SDK uninstalled |
| Email | Resend or SMTP SDK wrapper | `email` config and `app.email.send(...)` | A send succeeds through the configured provider | Wrapper deleted and SDK uninstalled |
| Env | `createEnv()` beside the app, `dotenv`, unchecked `process.env` reads | `env` passed to `createBunderstack()`; `app.env` / `ctx.env` | Boot fails with a clear message when a required variable is missing | Legacy env module unused; `.env.example` lists names only |
| Migrations | Schema push against production | Committed Drizzle `migrations/`, applied by `provision(app)` | `migrations/` is under version control and applies cleanly to an empty database | Push command removed from deployment |
| Deployment declaration | No `bunderstack.entry`, no blueprint | `package.json#bunderstack.entry` and a committed blueprint | `bun run blueprint:check` passes in CI | Deployment reads the blueprint rather than ad-hoc process config |
| App lifetime | Tests and scripts leaking app instances | `app.close()` in a `finally` or `afterEach` | The test run exits without hanging | — |

## Reading a partially migrated application

Some applications are already on Bunderstack for part of their surface. The
audit is the same, but the answer to "who owns this capability" is often *both*,
which is the state that causes production incidents.

A real example: an application whose Bunderstack modules live in
`src/bunderstack/` while `src/lib/` still holds an auth config, a schema
directory, and SDK wrappers, whose `package.json` has no `bunderstack.entry`,
no worker command, and no blueprint scripts, and whose deployment runs a single
web command. Nothing there is broken in development. In production it means the
declared entry is unknown to the host, queue jobs run inside web replicas or
not at all, and two auth configurations disagree about sessions.

Treat that shape as a sequence of the gates above, not as a file list to copy.
The directory names in any one application are incidental; the ownership
question is not.

## Order that keeps the application working

Auth and database first, because everything else reads them. Then access and
API mounting, so authorization is enforced in one place before routes move.
Then storage, email, jobs, and cron, which are independent of each other. Then
realtime, which depends on the write paths already being correct. Migrations
and the blueprint last, because they declare the finished shape.

Deleting in the reverse order of adoption keeps the system reversible: the
replacement is live and tested before its predecessor stops existing.
