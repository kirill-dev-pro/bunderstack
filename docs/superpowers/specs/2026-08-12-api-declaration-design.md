# API Declaration Ergonomics Design

## Status

Validated design. It builds on the oRPC-first redesign in
`docs/plans/2026-08-11-orpc-simplification-design.md`. It does not change the
procedure graph, the transport, or the client. It changes how an application
declares its procedures.

This document uses ASD-STE100 (Simplified Technical English).

## Goal

An application must declare its API with plain modules and plain imports. The
framework must not force factory functions, hand-written generics, or a bag of
procedures passed through arguments.

## Evidence

The design comes from one real application: `hrbreakers.com-bunderstack`. That
application declares about 20 custom procedures in five router files. The
sections below name the file and the line for each problem.

## Problem 1: the builder exists only inside a callback

The `api` option takes a callback (`config.ts:171`). The builder is an argument
of that callback. Therefore the builder does not exist at module scope.

The application works around this in three ways:

1. Every router file exports a factory. Each factory takes a bag of procedures:
   `createTelegramRouter({ protectedProcedure })`.
2. The application declares a type for that bag: `HRBreakersProcedures`.
3. Every router file imports that type from `./api/index.ts`, and
   `./api/index.ts` imports every router factory. This is a circular import
   between the router modules and the index module.

The callback is not required. `createApiBuilder` (`api/builder.ts:12`) is a pure
factory over `os.$context<ApiContext<TSchema, TEnv>>()`. It does not read the
application instance. The context arrives at request time.

## Problem 2: the application writes the generics by hand

The application declares this type:

```ts
type HRBreakersApiBuilder = BunderstackApiBuilder<
  typeof schema,
  ValidatedEnv<typeof envSchema>
>
```

The author must know the `ValidatedEnv` helper. Nothing connects this type to
the configuration that `createBunderstack` receives.

## Problem 3: the framework has no extension point for base procedures

The application needs three additions over `o.public` and `o.protected`:
instrumentation, a role check, and an `adminProcedure` base.

The framework offers no place to declare them. Therefore the application
declares a middleware with a raw `os.$context<{ user?: { id: string } }>()`
(`api/index.ts:29`). A comment in that file explains why a generic wrapper does
not work.

The larger effect is not visible in the application source. The application
applies its instrumentation to `publicProcedure` and `protectedProcedure`. The
framework builds the CRUD, storage, and realtime procedures inside
`buildApiRouter` (`api/router.ts:14`). Those procedures do not pass through the
application bases.

Therefore the application has Sentry spans and PostHog logs for its own 20
procedures, and no observability for the generated CRUD. The generated CRUD
serves the larger part of the traffic. The author did not choose this result.

## Problem 4: the application reloads the user role on every call

The application runs a middleware that reads the role from the database when
`context.user.role` is empty (`api/index.ts:69`).

The framework already reads `session.user.role` in `resolveAccessUser`
(`access.ts:501`). The application enables the Better Auth admin plugin.
Therefore the middleware is probably redundant, and it costs one database query
for each protected call.

"Probably" is not sufficient to delete code. The implementation plan must prove
the behavior with a test before it removes the middleware.

## Problem 5: the application repeats the list query three times

The file `api/admin.ts` contains three blocks of about 40 lines. Each block
builds `limit`, `offset`, filters, and `totalCount` by hand. The blocks differ
only in the table and the filter columns.

Each block also builds the `AND` clause with
`conditions.reduce((acc, cond, i) => …)`. Drizzle provides `and()` for this.

The framework already has `resolveListParams` and `executeList`
(`list-query.ts:99` and `list-query.ts:247`). They provide filters, search,
sort, cursor, and count. Only the generated CRUD can reach them.

## Problem 6: the framework does not export the database types

`DbFor` is internal (`db.ts:14`). The index module imports it but does not
export it.

Therefore a helper in a separate application file cannot type its database
parameter. The application uses `any`: `assertAndSpendCredits(database: any)`
and `tx: any` (`api/adaptation.ts:73` and `api/adaptation.ts:98`).

The alternative, `typeof app.db`, creates an import cycle through the
application index module.

## Problem 7: the application does not use the typed errors

The framework declares `BUNDERSTACK_ERRORS` and maps `BunderstackError` into
typed oRPC errors (`errors.ts:38`). The set contains `BAD_REQUEST`,
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, and
`TOO_MANY_REQUESTS`.

The application throws `new ORPCError('NOT_FOUND', …)` directly. It uses four
codes, and the framework declares all four. Therefore this is a documentation
problem. The framework needs no change.

## Problem 8: two paths lead to the environment

The file `api/credit.ts` imports `env` from `../env` (`api/credit.ts:23`). The
context already carries `context.env`. Two paths exist for one value.

## Rejected: an ownership helper for custom procedures

An earlier draft proposed `context.access.require(table, id)`. It would call the
same `crud-operations.ts` code that the generated `get` procedure calls. It
would remove six ownership checks from the application.

This proposal is rejected. The reason is in the application configuration.

`access.ts` declares `adaptations: { create: 'deny', update: 'deny' }`. The
custom procedure `adaptation.create` inserts rows into that table. The custom
procedure `adaptation.cancel` updates it.

Therefore `access.ts` is the policy for the generated surface only. Custom
procedures follow a different policy on purpose. They exist because the
declarative model does not fit them.

The two rule sets are not two sources of one truth. They are two policies for
two surfaces. A helper that routes custom procedures through `access.ts` would
be a category error.

An application that wants such a check can write four lines in its own base
module.

This rejection also removes two risks: a change to the meaning of `crud: false`,
and a new field in `ApiContextDeps`.

## Design

### D1: `defineApi` returns a builder at module scope

```ts
// src/bunderstack/api/base.ts
import { defineApi } from 'bunderstack'

import { envSchema } from '../env'
import { schema } from '../schema'

export const o = defineApi({ schema, env: envSchema })

export const publicProcedure = o.public
export const protectedProcedure = o.protected
export const adminProcedure = o.protected.use(async ({ context, next, errors }) => {
  if (context.user.role !== 'admin' && context.user.role !== 'superadmin') {
    throw errors.FORBIDDEN({ message: 'Admin access required' })
  }
  return next()
})
```

`defineApi` calls `createApiBuilder` at runtime. It takes values, not type
parameters. It infers `TSchema` from `schema` and `TEnv` from `ValidatedEnv` of
`envSchema`.

`defineApi` does not read the application instance. Therefore no import cycle
with `createBunderstack` exists.

This solves problem 2. It also removes the reason for the factory pattern.

### D2: the `api` option accepts a router object

```ts
// src/bunderstack/api/index.ts
export const api = {
  public: publicRouter,
  telegram: telegramRouter,
  adaptation: adaptationRouter,
  credit: creditRouter,
  admin: adminRouter,
}
```

```ts
createBunderstack({ api })
```

The callback form stays supported. An application that needs the framework
builder inside the configuration can still use it.

Each router file becomes a plain module:

```ts
// src/bunderstack/api/telegram.ts
import { protectedProcedure } from './base'

export const telegramRouter = {
  getStats: protectedProcedure.handler(({ context }) => getTelegramStats(context.db)),
}
```

This solves problem 1. It removes five factories, the `HRBreakersProcedures`
type, the procedure bag, and the circular import.

### D3: the `middleware` option applies to the whole graph

The configuration takes an array of oRPC middlewares:

```ts
createBunderstack({
  middleware: [instrumentation],
  api,
})
```

`buildApiRouter` applies them with the builder method `.router()`:

```ts
builder.use(...middleware).router(mergedRouter)
```

oRPC documents this method as follows: "Applies the builder's middleware,
errors, and metadata to every procedure in the given router."
(`@orpc/server@2.0.0-beta.26`, `dist/index.d.mts:118`).

Therefore the middleware covers the CRUD, storage, realtime, and custom
procedures with one mechanism. The framework adds one configuration field and no
new concept.

The application declares the middleware with the same builder:

```ts
// src/bunderstack/api/base.ts
export const instrumentation = o.middleware(async ({ context, path, next }) => {
  const name = path.join('.')
  return Sentry.startSpan(
    { name, op: 'rpc.server', attributes: { 'rpc.method': name } },
    async () => {
      const startedAt = performance.now()
      try {
        return await next()
      } finally {
        logToPostHog('info', `oRPC ${name}`, {
          path: name,
          duration_ms: Math.round(performance.now() - startedAt),
          userId: context.peekSession()?.user?.id,
        })
      }
    },
  )
})
```

`o.middleware()` types the middleware over `ApiContext`. The application no
longer writes `os.$context<…>()`.

This solves problem 3.

### D4: `context.peekSession()`

The global middleware wraps the whole graph. It runs first, before the session
resolves. Therefore `context.user` is not available inside it.

`getSession()` is not correct here. If the session is not resolved, the call
resolves it. This removes the lazy resolution for every request. A webhook that
authenticates with a signature starts to pay for authentication.

`peekSession()` reads the memoized value. It returns the session or `undefined`.
It never starts a resolution.

```ts
peekSession(): { user: AccessUser | null; activeOrganizationId: string | null } | undefined
```

The documentation must state one rule: use `peekSession()` for observability
only. Do not use it for authorization.

### D5: `listSpec`

```ts
import { listSpec } from 'bunderstack'

const logsList = listSpec(appLogs, {
  filterable: ['level', 'action', 'userId'],
  sortable: ['createdAt'],
  defaultSort: { column: 'createdAt', order: 'desc' },
})

getLogs: adminProcedure.input(logsList.input).handler(logsList.handler),
```

`listSpec` returns the input schema and the handler separately. It builds the
schema with `buildListInputSchema`, and the handler calls `resolveListParams`
and `executeList`. The handler returns `ListResult<TTable['$inferSelect']>`.

**Why it does not return a finished procedure.** An earlier draft proposed
`listProcedure(procedure, table, options)`. That shape cannot preserve types.
TypeScript resolves a method call on a generic type parameter through the
parameter's constraint, not through the argument's real type. The constraint
cannot restate the generic `.input()` and `.handler()` signatures of the oRPC
builder, so the input schema and the row type are erased and the returned
procedure is `unknown`. The compiler reports:

```
Type 'unknown' is not assignable to type 'ListParamsInput | undefined'
Argument of type 'unknown' is not assignable to parameter of type 'Lazyable<Procedure<…>>'
```

With the two-part shape the base procedure stays concrete at the call site, so
`.input()` and `.handler()` are the real generic methods and inference is
exact. A test proves this: it reads `result.items[0].level` as `string` with no
cast, and fails to compile if the row type is lost.

`listSpec` is also not a builder method. A method such as `adminProcedure.list()`
would require a wrapper around the oRPC builder classes. The application would
lose direct access to the oRPC chain. This conflicts with the project rule
"re-export the raw instances, never seal them".

`listSpec` does not read `access.ts`. It takes its options at the call site. The
base procedure carries the policy. In this application `adminProcedure` already
checks the role.

This solves problem 5.

### D6: export the database types

The framework exports two types:

```ts
export type BunderstackDb<TSchema extends Record<string, unknown>> = DbFor<TSchema>

export type BunderstackTx<TSchema extends Record<string, unknown>> = Parameters<
  Parameters<DbFor<TSchema>['transaction']>[0]
>[0]
```

`DbFor` already exists (`db.ts:14`). The index module imports it but does not
export it. The plan exports it under a public name.

Drizzle does not export one transaction type for both dialects. Therefore the
plan derives `BunderstackTx` from the transaction callback parameter of
`DbFor`. A type test must prove that the derived type works for the libSQL
dialect and for the Postgres dialect.

This solves problem 6. The application types its helpers instead of using `any`.

### D7: documentation rules

Three items need documentation and no framework change:

- Throw typed errors with the `errors` argument of the handler. Do not construct
  `ORPCError` directly. (Problem 7.)
- Read the environment from `context.env`. Do not import the environment module
  inside a procedure. (Problem 8.)
- Declare the base procedures in one module. Import them into the router
  modules.

## Framework changes

| Change | Scope |
| --- | --- |
| `defineApi({ schema, env })` | New export. Wraps `createApiBuilder`. |
| `api` accepts a router object | `config.ts`, `index.ts`. Callback stays. |
| `middleware: [...]` option | `config.ts`, `api/router.ts`. |
| `context.peekSession()` | `api/context.ts`. |
| `BunderstackDb`, `BunderstackTx` | New type exports from `db.ts`. `BunderstackTx` is derived. |
| `listSpec` | New export. Needs the refactor below. |

### Required refactor

`buildTableCrudProcedures` builds the list input schema inline
(`api/crud-router.ts:174`). The plan must extract that code into a shared
function. `listSpec` and the CRUD router must then use one implementation.

The refactor is mechanical. The existing CRUD tests cover the behavior.

## Application changes

| Change | File |
| --- | --- |
| Remove five router factories | `api/*.ts` |
| Remove `HRBreakersProcedures` and the procedure bag | `api/index.ts` |
| Remove the circular import between routers and index | `api/*.ts` |
| Replace `os.$context<…>()` with `o.middleware()` | `api/base.ts` |
| Remove the role middleware after a green test | `api/index.ts` |
| Replace `new ORPCError(…)` with `errors.*` | `api/*.ts` |
| Replace `import { env }` with `context.env` | `api/credit.ts` |
| Replace `any` with `Db` and `Tx` | `api/adaptation.ts` |
| Replace three list blocks with `listSpec` | `api/admin.ts` |

## Behavior changes to verify

**Instrumentation covers more procedures.** The generated CRUD, storage, and
realtime procedures now produce spans and logs. The volume of telemetry grows.
The application must decide whether to filter by `path`.

**A realtime subscription lives for a long time.** A `finally` block in a global
middleware runs when the stream closes, not when the subscription starts. The
documentation must state this. An application filters such paths itself.

**The list response shape changes.** The admin procedures return `ListResult`
instead of `{ items, totalCount }`. The admin client code needs an update. The
admin views gain cursor pagination and the shape that all other lists use.

**The user role may already be present.** A test must prove that
`context.user.role` is populated from the Better Auth session. The role
middleware is removed only after that test passes.

## Acceptance criteria

1. No application router file exports a factory that takes a procedure bag.
2. No import cycle exists between the router modules and the index module.
3. No application source declares `BunderstackApiBuilder<…>` by hand.
4. No application source calls `os.$context<…>()`.
5. A test proves that a configured middleware runs for a generated CRUD
   procedure, a storage procedure, and a custom procedure.
6. A test proves that `peekSession()` returns `undefined` when no code resolved
   the session, and that it does not start a resolution.
7. A test proves that a webhook procedure with a global middleware does not
   resolve the session.
8. A test proves that `context.user.role` carries the Better Auth role.
9. `listSpec` and the CRUD list procedure use one input-schema builder.
10. The application source contains no `any` in the API layer.
11. The examples and the documentation site show the module-scope pattern.

## Out of scope

- An ownership helper for custom procedures. See the rejection above.
- File-based or convention-based router discovery.
- A change to the meaning of `crud: false`.
- A declarative resource API such as `defineResource`.
- Any change to the client, the transport, or the procedure graph.
