# oRPC-First Bunderstack Simplification Design

## Status

Validated design for a breaking beta redesign of Bunderstack. Compatibility with
the Hono, tRPC, Zod-specific, and split REST/RPC APIs is intentionally out of
scope.

## Goal

Bunderstack should expose one mental model:

- one oRPC procedure graph;
- one request context;
- one typed client namespace;
- one validation protocol based on Standard Schema;
- one way to add application behavior.

Generated CRUD, files, realtime, health, custom procedures, and webhooks belong
to the same graph. oRPC projects that graph into its typed RPC transport,
ordinary HTTP routes, streaming responses, and optional OpenAPI. Better Auth is
the only foreign HTTP handler because it owns its protocol and route family.

The redesign is successful only if it removes meaningful framework code and
dependencies. Moving the existing Hono and realtime abstractions behind new
names is not sufficient.

## Design principles

1. **RPC types are primary.** Handler input, output, and error types form the
   application contract. OpenAPI is an optional projection.
2. **One transport implementation per capability.** CRUD, storage, and realtime
   are implemented once as oRPC procedures rather than maintained as parallel
   REST, RPC, and custom-SSE adapters.
3. **Keep domain behavior, delete transport ceremony.** Access checks, scopes,
   quotas, transforms, idempotency, and cache recovery remain. Hono contexts,
   manual SSE framing, duplicate clients, and adapter-parity machinery do not.
4. **Standard Schema is the validation boundary.** Bunderstack does not require
   one validation library from applications.
5. **Breaking changes are preferred over compatibility layers.** Bunderstack is
   still beta, so the redesign removes obsolete APIs in one step.

## Application model

The application author supplies schema, access, infrastructure, and optional
custom procedures:

```ts
import * as v from 'valibot'

const app = await createBunderstack({
  schema,
  access,
  auth,
  storage,
  realtime: true,
  jobs,

  api: (o) => ({
    stats: o.protected
      .route({ method: 'GET', path: '/api/board-stats' })
      .input(v.object({ boardId: v.string() }))
      .handler(async ({ context, input }) => {
        const todos = await context.db
          .select()
          .from(schema.todos)
          .where(eq(schema.todos.boardId, input.boardId))

        return {
          total: todos.length,
          done: todos.filter((todo) => todo.done).length,
          pending: todos.filter((todo) => !todo.done).length,
        }
      }),
  }),
})
```

The handler return type is the default output contract. `.output(schema)` is
optional and is used only when an application wants runtime output validation,
output transformation, or a precise OpenAPI response schema.

The builder exposes semantic bases over the same oRPC primitive:

- `o.public` does not resolve a Better Auth session;
- `o.protected` resolves and narrows `user` and `session`;
- `o.webhook` is a public HTTP-oriented alias documenting that authentication
  is normally performed with a provider signature and that raw request bytes
  are preserved.

## Unified procedure graph

`createBunderstack` constructs one router containing:

```text
api
├── health
├── <table>
│   ├── list
│   ├── get
│   ├── create
│   ├── update
│   └── delete
├── files
│   └── <bucket>
│       ├── prepareUpload
│       ├── upload
│       ├── confirmUpload
│       ├── download
│       └── delete
├── realtime
│   └── changes
└── <custom procedures>
```

Generated and custom procedures use the same context, registry, collision
validation, typed errors, RPC client, HTTP handler, and TanStack Query utilities.

## Request dispatch

Hono is not replaced with another general-purpose router. `app.handler` is a
small Web Standard dispatcher:

```text
Request
  -> global rate limit
  -> /api/auth/*  -> Better Auth handler
  -> /api/rpc/*   -> oRPC RPCHandler
  -> all others   -> oRPC OpenAPIHandler
  -> 404
```

The Better Auth prefix is reserved before the oRPC handlers are constructed.
All other route precedence and ambiguity checks are owned by the single oRPC
registry. The dispatcher passes a lazily evaluated `ApiContext` created from an
untouched `Request` and a clone reserved for raw-body reads.

`app.router`, the `routes:` config option, `RouteContext`, and Hono-specific
extension points are removed. Applications express normal HTTP endpoints with
oRPC `.route(...)`. A truly unusual protocol can wrap `app.handler` outside
Bunderstack without forcing a second router into every application.

## Standard Schema and Valibot

All public validation slots accept Standard Schema:

- custom procedure inputs and optional outputs;
- environment variables;
- job payloads;
- future extension validation points.

Bunderstack uses the Standard Schema `~standard.validate` contract internally
and infers values with `InferOutput`. Validation errors are normalized into the
common Bunderstack typed-error shape.

Generated schemas use Valibot:

- CRUD select, insert, and update schemas come from `drizzle-orm/valibot`;
- internal manifest/config schemas use Valibot where runtime validation is
  useful;
- built-in realtime and storage procedure schemas use Valibot.

Applications may use Valibot, Zod, ArkType, or another Standard Schema library.
Zod is no longer a Bunderstack runtime or peer dependency. `drizzle-zod` and
`@orpc/zod` are removed from the default dependency graph.

Synchronous framework boot paths must either reject asynchronous schemas with a
clear error or be made explicitly asynchronous. The implementation plan must
decide this per call site instead of accidentally accepting unresolved promises.

## Webhooks and arbitrary HTTP procedures

A webhook is an ordinary procedure with an HTTP route:

```ts
stripeWebhook: o.webhook
  .route({ method: 'POST', path: '/webhooks/stripe' })
  .input(stripeEventSchema)
  .handler(async ({ input, context }) => {
    const rawBody = await context.getRawBody()
    const signature = context.request.headers.get('stripe-signature')

    await verifyStripeWebhook(rawBody, signature, context.env.STRIPE_SECRET)
    await context.jobs.enqueue('processStripeEvent', input)

    return { received: true }
  })
```

The context provides the original headers and a memoized raw-body clone, so
signature verification observes the exact bytes received. Session resolution is
lazy and therefore costs nothing for signature-authenticated webhooks. Detailed
oRPC input/output structures remain available for procedures that need typed
headers, query parameters, status codes, or response headers.

## Realtime with oRPC Publisher

The custom SSE broker and browser transport are replaced by oRPC Event Iterator
and `@orpc/experimental-publisher`.

The publisher owns:

- subscription registration and cleanup;
- memory or Redis fan-out;
- event IDs;
- retention and replay;
- resume from `lastEventId`.

Bunderstack publishes one typed event family:

```ts
type RealtimeEvents = {
  change: {
    table: string
    action: 'create' | 'update' | 'delete'
    record: Record<string, unknown>
  }
}
```

Generated writes and `context.realtime.publish()` call
`publisher.publish('change', event)`. The `realtime.changes` procedure subscribes
with `signal` and `lastEventId`, filters requested tables, resolves the caller,
and applies existing access and scope predicates before yielding an event.

The publisher's replay buffer is an optimization, not the source of cache
correctness. On every reconnect, the Bunderstack client invalidates queries for
the subscribed tables after the subscription is established. Retained events
provide fast incremental recovery; an expired retention window falls back to a
normal refetch. The public `gap` state and protocol are removed.

The implementation should use `MemoryPublisher` locally. Production Redis
should use the smallest compatible publisher adapter. If adopting ioredis would
add more weight than it removes, implement a narrow `Bun.RedisClient` publisher
adapter against the oRPC Publisher abstraction rather than retaining the old
broker.

The following custom code is removed:

- `GET` plus `POST /api/realtime` handshake;
- `clientId` registration;
- SSE framing and parsing;
- manual watchdog, visibility listener, and reconnect loop;
- memory replay implementation;
- Redis event log and sequencing implementation;
- public `createRealtimeClient` transport.

Only access filtering and TanStack Query cache application remain
Bunderstack-specific.

## Storage through oRPC

Storage retains a transport-neutral `StorageOperations` core:

```ts
type StorageOperations = {
  prepareUpload(...): Promise<...>
  upload(...): Promise<...>
  confirmUpload(...): Promise<...>
  download(...): Promise<...>
  delete(...): Promise<void>
}
```

It owns the existing behavior:

- create/get/delete access rules;
- owner and scope checks;
- MIME and size validation;
- per-user and per-scope quotas;
- pending upload metadata and confirmation;
- orphan cleanup;
- public and private redirects;
- proxy downloads;
- image transforms and derivative caching.

Generated oRPC procedures are thin adapters over these operations. oRPC native
`File`, `Blob`, root `ReadableStream`, detailed output, response headers, status
codes, redirects, and catch-all parameters cover the existing HTTP behaviors.

The client exposes one upload operation. For local storage it performs a proxy
upload. For a presign-capable backend it internally performs prepare, direct
`PUT`, and confirm. Backend selection is not application code.

Only one canonical file URL remains:

```text
/api/files/{bucket}/{+path}
```

The `/files/*` alias and its duplicate routing/test surface are removed.

## Client model

`createClient<App>` creates one oRPC client plus TanStack Query utilities:

```ts
const api = createClient<App>({
  queryClient,
  realtime: true,
})

useQuery(api.todos.list.queryOptions({ input: { boardId } }))
useMutation(api.todos.create.mutationOptions())
useQuery(api.stats.queryOptions({ input: { boardId } }))

await api.files.images.upload.call(file)
api.files.images.url(fileId, { width: 320, format: 'webp' })
```

Generated CRUD and custom procedures no longer use different nesting or method
names. The following split surfaces are removed:

- root REST table proxies;
- nested `api.api` oRPC utilities;
- separate bucket transport client;
- separate realtime transport client;
- legacy tRPC client utilities.

`files.<bucket>.url()` is a pure URL-construction helper attached to the unified
namespace; it is not a second transport.

With `realtime: true`, the client consumes `api.realtime.changes`, applies
create/update/delete events to generated CRUD query keys, and invalidates the
subscribed tables on reconnect. Advanced consumers can call the streaming
procedure directly and iterate over its typed events.

## Typed errors

All built-in procedures inherit one declared error set:

```ts
const base = os.errors({
  VALIDATION_ERROR: { status: 400 },
  UNAUTHORIZED: { status: 401 },
  FORBIDDEN: { status: 403 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  PAYLOAD_TOO_LARGE: { status: 413 },
  RATE_LIMITED: { status: 429 },
})
```

Transport-neutral operations throw one internal `BunderstackError`. A shared
oRPC middleware maps it into the declared typed error, preserving the framework
error code, message, and optional details. Per-procedure `try/catch`, Hono
`apiError`, duplicated status maps, and client-only error decoding are removed.

Custom procedures may extend the declared error set with domain-specific typed
errors. Unhandled exceptions are encoded as internal server errors and do not
leak private details.

## Optional OpenAPI

OpenAPI is not part of application boot correctness. RPC and routed HTTP
procedures operate without generating a specification.

When enabled, Bunderstack serves `/api/openapi.json` and merges Better Auth's
foreign schema. Inputs, routes, and declared errors appear when their schemas
have compatible converters. A procedure without `.output()` has an unspecified
response body. Adding `.output(schema)` enables precise response documentation
and runtime output validation.

An unsupported custom Standard Schema library must not prevent construction of
the RPC router. OpenAPI generation reports the specific procedure and missing
converter. Bunderstack ships the Valibot converter required for generated
procedures; other converters are explicit opt-ins.

## Dependency and API removals

The redesign removes:

- `hono` and all `Context`/`Hono` types;
- `@trpc/server`, `@trpc/client`, and tRPC TanStack Query integration;
- `zod`, `drizzle-zod`, and the default `@orpc/zod` converter;
- `routes`, `RouteContext`, and `app.router`;
- `trpc`, `trpcRouter`, and legacy client inference;
- the Hono CRUD adapter;
- the Hono storage router;
- the Hono realtime router;
- manual realtime client transport;
- duplicate REST table and bucket clients;
- transport-parity tests that exist only because two implementations coexist.

All oRPC core, client, OpenAPI, TanStack Query, Publisher, and schema-converter
packages must be pinned to one exact mutually compatible release. The existing
spike versions are evidence of viability, not a version set to copy without a
compatibility check.

## Verification and acceptance criteria

The redesign is accepted only when all of the following are true:

1. Runtime source and package manifests contain no imports or dependencies on
   Hono, tRPC, Zod, or drizzle-zod.
2. One router type drives generated CRUD, files, realtime, custom procedures,
   the RPC client, and TanStack Query utilities without public `any` casts.
3. Existing access, scope, idempotency, list, cursor, and error-envelope behavior
   passes through the single oRPC implementation.
4. Webhook tests prove exact raw-body preservation and lazy session resolution.
5. Storage tests prove proxy upload, presigned upload, confirmation, download
   streaming, redirects, transforms, quotas, access, and cleanup through the
   generated procedures and canonical `/api/files/*` URLs.
6. Realtime tests prove typed delivery, table and record filtering, access and
   scope filtering, reconnect replay, expired-retention refetch, cleanup, and
   Redis delivery between two application instances.
7. The unified client drives CRUD, custom procedures, files, and realtime in the
   Todo and Twitter examples without separate transport setup.
8. OpenAPI is verified as an opt-in contract, including generated mobile-client
   compilation, but missing output schemas do not fail normal application boot.
9. Dependency-boundary and browser-bundle tests prove that server packages and
   schema converters do not leak into client bundles.
10. The production source diff is materially net-negative in lines and files.
    Reviews reject abstractions that merely relocate deleted transport code.

## Out of scope

- Backward compatibility for `routes`, `app.router`, tRPC, or the split REST
  client.
- Maintaining `/files/*` as an alias.
- Reimplementing provider-specific webhook signature algorithms.
- Making OpenAPI responses precise without runtime output schemas.
- Replacing Better Auth's own HTTP protocol with oRPC.
- Preserving the old realtime `clientId` or `gap` wire protocol.
