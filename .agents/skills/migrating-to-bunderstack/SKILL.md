---
name: migrating-to-bunderstack
description: Use when moving an existing or partially migrated application onto Bunderstack and replacing its separate auth, database, API, storage, email, jobs, cron, or realtime infrastructure, or when finishing a migration that stalled part-way.
---

# Migrating to Bunderstack

Migration deletes infrastructure rather than wrapping it, and the application
stays working at every phase. For a new application with no existing
infrastructure, use `creating-bunderstack-apps` instead.

## Workflow

1. Inventory current auth, database, API, storage, email, jobs, cron, realtime,
   env, migrations, and deployment ownership. Record which module owns each
   capability today and which call sites depend on it.
2. Add a migration contract test before removing legacy paths, so every
   deletion has a gate that fails when behaviour is lost.
3. Establish one Bunderstack backend declaration, one runtime, and one schema aggregate.
4. Move auth and access without creating duplicate instances.
5. Replace infrastructure capability by capability.
6. Mount one handler and separate the production worker.
7. Remove wrappers only after call sites and tests move.
8. Generate migrations and the blueprint, then verify production topology.

## One live instance per capability

The most damaging migration state is two working implementations of the same
capability. A second Better Auth instance splits session validation. A second
database client sits outside provisioning, migration state, and request
transactions. A second env schema drifts from the validated one and passes
locally while failing at boot.

Pass `authConfig` into `bunderstack()`, start that declaration once in the web
entry, and re-export `app.auth` and `app.db` from the runtime entry. Let the
declared `env` schema plus the source passed to `backend.start()` be the only
validated source. A more specific file route also shadows the catch-all, so a
surviving `/api/auth/$` silently keeps serving the instance you meant to delete.

## Replacements

| Legacy shape                                                  | Current contract                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Hand-written `ALL: ({ request }) => app.handler(request)` map | `createApiHandlers(app)` on one `/api/$` route                                    |
| Separate `/api/auth/$` or `/api/trpc/$` mounts                | Deleted; the catch-all serves Better Auth and the unified oRPC `/api/rpc/*` graph |
| tRPC router and procedure clients                             | Router modules over `defineApi` bases, passed as `api`, with one inferred client  |
| Per-file router factories taking a bag of procedures          | Bases exported from one module, imported by plain router objects                  |
| Hand-built `ORPCError` or a second error model                | `errors.CODE({ message })`, or `BunderstackError` outside a handler               |
| Tracing attached to an application base                       | `middleware: [...]`, which also covers the generated CRUD                         |
| Hand-rolled limit/offset/count blocks                         | `listSpec(table, options)` applied to your own base                               |
| `any`-typed db parameters in helpers                          | `BunderstackDb<typeof schema>` and `BunderstackTx<typeof schema>`                 |
| Worker started from the web entry                             | `src/worker.ts` owning `app.runWorker()`                                          |
| `/api/cron/*` guarded by a shared secret                      | `jobs.cron()` with platform delivery                                              |
| Channel-and-payload realtime publishing                       | `ctx.realtime.publish(schema.tasks, 'update', row)` after the write commits       |
| AWS or Tigris SDK wrapper                                     | `app.storage` buckets                                                             |
| Resend SDK wrapper                                            | `app.email.send(...)`                                                             |
| `createEnv()` beside the app                                  | `env` schema in `bunderstack()` and source in `backend.start()`                    |
| Implicit database driver                                      | Explicit adapter, `database: { adapter: libsql(), url }`                          |
| Schema push in production                                     | Committed Drizzle `migrations/`, applied by `provision(app)`                      |
| Undeclared deployment                                         | `package.json#bunderstack.entry` and a checked blueprint                          |

Read [runtime replacements](references/runtime-replacements.md) before writing
any replacement above; it holds the current snippets and the realtime transport
rule for multi-process deployments. Read the
[audit checklist](references/audit-checklist.md) during phase 1 to inventory
ownership, and again at phase 7 before each deletion.

## Deletion gate

Do not delete a legacy module until its replacement is mounted, every call site
imports the replacement, a migration contract test covers the behaviour, and
`bun run typecheck` reports no remaining importers. A one-release re-export
shim is acceptable when call sites are numerous; the shim is deleted under this
same gate. Uninstall the replaced SDK package in the commit that removes its
last importer, so a stale wrapper cannot be reintroduced silently.

Tests should use lexically scoped `await using` fixtures from `backend.test()`;
scripts that explicitly start a runtime must close the runtime they own.

## Production gate

Before the cutover deploy: committed migrations exist, the worker runs as its
own process, web and worker share a realtime transport if jobs publish events,
`package.json#bunderstack.entry` points at the entry, and
`bun run blueprint:check` passes in CI.
