# Application structure

## Keep the entry declarative

The Bunderstack entry constructs and exports `app` (and usually `type App =
typeof app`), configures the declared capabilities, and calls `provision(app)`
when the application owns provisioning. Keep unrelated external side effects
out of its import graph: the blueprint command imports this entry with
`BUNDERSTACK_INTROSPECT=1`.

Start a small API in `src/bunderstack.ts`. Split a meaningful configuration
into `src/bunderstack/` with `index.ts`, `schema/`, `access.ts`, `auth.ts`,
`env.ts`, `jobs/`, and `trpc/` as needed. The entry remains the one place that
assembles those modules into `createBunderstack()`; do not create parallel app,
database, or auth instances.

## Aggregate the schema

Export every domain, Better Auth, plugin, and Bunderstack internal table from
the schema object passed to `createBunderstack()`. Include
`export * from 'bunderstack/schema'` so migrations include the internal tables.
Define Better Auth tables required by the selected auth flows and plugins; do
not assume a minimal auth configuration needs every optional provider table.

## Define authorization on the server

Use `defineAccess(schema, rules)` for generated CRUD. Give each exposed table
an explicit operation policy and set `ownerColumn` for owner rules. Keep auth,
internal, and administrative tables out of generated CRUD unless deliberately
exposing the supported `user` table.

Use `scope.read` and `scope.write` to enforce tenant columns on generated
lists, reads, and writes. For example, an organization-owned table can derive
`{ organizationId: ctx.session?.activeOrganizationId ?? '__none__' }`, keeping
users without an active organization outside tenant rows. Use protected tRPC
procedures for authorization that depends on related rows or roles; hiding a
UI route is not authorization.

## Keep credentials environment-owned

Declare validated server and browser-safe client variables in `env`. Server
variables must not use the `PUBLIC_` prefix; client variables must use it.
Use `app.env` (and `ctx.env`) rather than duplicating unchecked configuration.
Commit `.env.example` with names and safe placeholders only. Keep production
secrets, database URLs, storage credentials, and auth secrets in the runtime
environment.

Use local libSQL storage and console email for development when appropriate;
declare production adapters and credentials through configuration and runtime
environment rather than hard-coding them.

## Publish direct writes

Generated CRUD publishes realtime changes automatically. For a write through
`app.db` or `ctx.db`, return the complete changed row, wait for its transaction
to commit, then publish it with the table object:

```ts
const [task] = await ctx.db
  .update(schema.tasks)
  .set({ status: 'done' })
  .where(eq(schema.tasks.id, taskId))
  .returning()

await ctx.realtime.publish(schema.tasks, 'update', task)
```

Do not publish from inside an enclosing transaction. The complete row lets the
existing access filter evaluate owner and read-scope columns.
