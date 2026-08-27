# Application structure

## Separate declaration from runtime

`src/bunderstack/backend.ts` synchronously constructs and exports `backend =
bunderstack({...})`. It is pure: it validates the declaration and exposes
`backend.manifest`, but it does not connect to infrastructure. The blueprint
imports this declaration without starting the application.

`src/bunderstack/index.ts` owns the production runtime: it imports `backend`,
calls `await backend.start()`, exports `app`, and calls `provision(app)` when the
application owns provisioning. Keep unrelated external side effects out of the
backend import graph.

Start a small API in `src/bunderstack.ts`. Split a meaningful configuration
into `src/bunderstack/` with `backend.ts`, `index.ts`, `schema/`, `access.ts`, `auth.ts`,
`env.ts`, `jobs/`, and `api/` as needed. The entry remains the one place that
starts the declared backend; do not create parallel app,
database, or auth instances.

## Aggregate the schema

Export every domain, Better Auth, plugin, and Bunderstack internal table from
the schema object passed to `bunderstack()`. Include
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
users without an active organization outside tenant rows. Use protected oRPC
procedures built from `o.protected` when authorization depends on related rows
or roles; hiding a UI route is not authorization.

## Extend the one API graph

Declare the builder once at module scope with `defineApi({ schema, env })`. It
infers the schema and env types from the values, so no application writes
`BunderstackApiBuilder<...>` by hand, and it reads nothing at runtime.

```ts
// src/bunderstack/api/base.ts
export const o = defineApi({ schema, env: envSchema })
export const publicProcedure = o.public
export const protectedProcedure = o.protected
```

Router modules are plain objects that import the base they need, and the entry
passes the finished router as `api`:

```ts
// src/bunderstack/api/projects.ts
export const projectsRouter = {
  stats: protectedProcedure.input(...).handler(...),
}

// src/bunderstack/api/index.ts
export const api = { projects: projectsRouter }

// backend.ts
bunderstack({ schema, database, api })
```

Do not write a router factory that receives a bag of procedures. That shape
only existed because `api` used to be a callback. The callback form,
`api: (o) => ({ ... })`, still works for a router that must be built from the
framework builder at configuration time.

Use `o.public`, `o.protected`, or `o.webhook`; add `.route(...)` only when a
stable HTTP projection is useful. Generated CRUD, custom procedures, files,
health, and `realtime.changes` remain in the same typed oRPC graph and client.

## Give a group of procedures its own base

A base is an oRPC builder, so `.use()` produces another one. Declare a rule
once instead of repeating it in every handler that depends on it:

```ts
export const adminProcedure = o.protected.use(
  async ({ context, next, errors }) => {
    if (context.user.role !== 'admin') {
      throw errors.FORBIDDEN({ message: 'Admin access required' })
    }
    return next()
  },
)
```

`next({ context })` merges into the context and types it for everything
downstream, which is how an organization scope or a resolved tenant reaches
handlers without an argument.

## Instrument the whole graph, not one base

Bunderstack builds the CRUD, storage, and realtime procedures itself, so they
never pass through a base the application declares. A middleware attached to
`o.protected` therefore measures the application's own procedures and leaves
the generated CRUD — usually the larger share of traffic — unmeasured.

Register cross-cutting middleware in the configuration instead:

```ts
const instrumentation = o.middleware(async ({ context, next, path }) => {
  if (path[0] === 'realtime') return next()
  const startedAt = performance.now()
  try {
    return await next()
  } finally {
    record(
      path.join('.'),
      performance.now() - startedAt,
      context.peekSession()?.user?.id,
    )
  }
})

bunderstack({ schema, database, middleware: [instrumentation], api })
```

Three rules apply to a graph-wide middleware. It runs before authentication, so
`context.user` does not exist there. Read the caller with
`context.peekSession()` after `await next()`, never `getSession()`: forcing the
session makes every request pay for authentication, including signed webhooks
that never needed it, and `peekSession()` is for observability only, never for
authorization. A realtime subscription is one long-lived call, so code after
`await next()` runs when the stream closes, not when it starts.

## Raise declared errors

Every procedure carries one error map: `BAD_REQUEST`, `UNAUTHORIZED`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`,
`TOO_MANY_REQUESTS`. Inside a handler or middleware, raise from the `errors`
argument, with extra context in `data.details`:

```ts
throw errors.NOT_FOUND({ message: 'Project not found' })
```

Code outside a handler — a service function or a job — has no `errors`
argument. Throw `BunderstackError`, which the framework maps to the same typed
error. Do not construct `ORPCError` by hand anywhere.

## Give list endpoints the shared contract

`listSpec(table, options)` gives a procedure you write the same filter, sort,
cursor, and count contract the generated CRUD list uses. Apply both parts to
your own base, which is what preserves the row type to the client:

```ts
const logsList = listSpec(appLogs, {
  filterable: ['level'],
  sortable: ['createdAt'],
})
logs: adminProcedure.input(logsList.input).handler(logsList.handler)
```

It reads no `access` configuration; the base procedure carries the policy.

## Type helpers that take the database

A service module cannot reach `typeof app.db` without an import cycle back to
the entry. Use `BunderstackDb<typeof schema>` and `BunderstackTx<typeof schema>`
instead of `any`.

## Keep the entry out of its own import graph

The api router and everything it imports are evaluated when the entry is
imported. A module in that graph that imports the app back — a bot client
reading `db`, a logger reading `app.env` — closes a cycle and breaks module
initialization. Load the app lazily in such a module.

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
