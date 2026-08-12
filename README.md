# bunderstack

Bunderstack is a batteries-included Bun backend built around one type-safe
oRPC graph. A Drizzle schema and one config produce CRUD procedures, custom
procedures, webhooks, auth, files, realtime, jobs, email, and validated env.
The application exposes one Web Standard `Request → Response` handler.

```sh
bun add bunderstack better-auth drizzle-orm valibot @libsql/client
```

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'
import * as v from 'valibot'
import * as schema from './schema'

export const app = await createBunderstack({
  schema,
  database: { adapter: libsql(), url: 'file:./data.db' },
  auth: { emailAndPassword: { enabled: true } },
  access: {
    posts: {
      ownerColumn: 'userId',
      list: 'public',
      get: 'public',
      create: 'authenticated',
      update: 'owner',
      delete: 'owner',
    },
  },
  realtime: true,
  api: (o) => ({
    greeting: o.public
      .route({ method: 'GET', path: '/api/greeting' })
      .input(v.object({ name: v.string() }))
      .handler(({ input }) => ({ message: `Hello, ${input.name}` })),
  }),
})

await provision(app)
Bun.serve({ fetch: app.handler })

export type App = typeof app
```

## One API graph

Every generated table has `list`, `get`, `create`, `update`, and `delete`
procedures. Application procedures declared under `api` join those procedures,
file buckets, health, and `realtime.changes` in the same router. The graph is
available through both `/api/rpc/*` and routed HTTP projections declared with
`.route(...)`.

There is no framework router to compose and no separate custom-procedure
client. Better Auth keeps its provider-defined `/api/auth/*` routes; everything
else is dispatched by Bunderstack's Web Standard handler.

```ts
import { QueryClient, useQuery } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })

const posts = useQuery(
  api.posts.list.queryOptions({
    input: { limit: 20, sort: 'createdAt', order: 'desc' },
  }),
)

await api.posts.create.call({ title: 'Typed end to end' })
await api.greeting.call({ name: 'Ada' })
```

Handler return inference is the usual output contract. Add `.output(schema)`
when runtime output validation, exact OpenAPI output, binary/detailed output,
or an event iterator requires it.

## Standard Schema validation

Public validation slots accept the Standard Schema interface. Valibot is the
default and is used internally, but another compatible schema library can be
used for application inputs. Boot-time env and job validation must be
synchronous.

```ts
env: {
  server: { API_KEY: v.pipe(v.string(), v.minLength(1)) },
  client: { PUBLIC_APP_NAME: v.optional(v.string(), 'My app') },
}
```

## Webhooks

A webhook is an ordinary routed oRPC procedure on the unauthenticated
`o.webhook` base. It supports provider-specific POST paths and typed payloads
without another router.

```ts
api: (o) => ({
  stripeWebhook: o.webhook
    .route({ method: 'POST', path: '/api/webhooks/stripe' })
    .input(stripeEventSchema)
    .handler(async ({ input, context }) => {
      // For signature schemes that require the exact bytes:
      const rawBody = await context.getRawBody()
      await handleStripeEvent(input, rawBody)
      return { received: true }
    }),
})
```

`context.getRawBody()` is lazy and memoized, so signature verification sees
the original bytes. `o.protected` is available for session-authenticated
procedures; all procedure failures use the shared typed Bunderstack error map.

## Realtime with oRPC Publisher

CRUD writes publish access-filtered row changes automatically. Custom writes
publish the complete returned row after the transaction commits:

```ts
await context.realtime.publish(schema.posts, 'update', post)
```

The client consumes the typed `realtime.changes` async iterator. Publisher
metadata carries event IDs, resumable delivery, and reconnect state; there is
no client registration or separate subscription POST protocol.

Idle streams carry a transport-only `heartbeat` every five seconds so Bun and
intermediate HTTP servers keep the response open. The query client consumes
heartbeats internally: they do not update cache state, call `onChange`, enter
the Publisher replay buffer, or advance `lastEventId`.

```ts
import { syncRealtime } from 'bunderstack-query'

const realtime = syncRealtime({
  api,
  queryClient,
  tables: ['posts', 'comments'],
})

realtime.close()
```

`realtime: true` uses the in-memory Publisher. Use
`realtime: { redis: process.env.REDIS_URL! }` when web and worker processes or
multiple instances must share events. `app.realtime.transport` reports
`disabled`, `memory`, or `redis`.

## Files

Configured buckets are generated under `api.files.<bucket>` and have typed
upload, download, confirmation, and deletion procedures. The query client adds
small domain helpers:

```ts
const uploaded = await api.files.avatars.upload(file)
const url = api.files.avatars.url(uploaded.fileId, { w: 160, format: 'webp' })
await api.files.avatars.delete(uploaded.fileId)
```

## Optional OpenAPI

Set `openapi: true` to serve `/api/openapi.json`. It is intentionally optional:
the native oRPC graph and its TypeScript client work without a JSON Schema
converter. Routed procedures are also convenient for generated mobile clients
and third-party HTTP integrations.

## TanStack DB collections

`bunderstack-sync` layers optimistic TanStack DB collections over the same
oRPC client:

```ts
import { createSyncClient } from 'bunderstack-sync'

const sync = createSyncClient<App>({ queryClient })
const posts = sync.posts.collection
const feed = sync.posts.scopedCollection({
  filters: { replyToId: null },
  sort: 'createdAt',
  order: 'desc',
})
await feed.loadMore()
```

Generated CRUD returns the canonical changed row. `bunderstack-sync` writes
that response into every materialized view without a follow-up list refetch;
the later realtime echo is an idempotent confirmation. Updates to the same row
are coalesced while a request is in flight, which keeps cursor-like optimistic
writes responsive without building a request queue in application code.

## Deployment and lifecycle

Generate and commit the provider-neutral deployment contract with:

```sh
bunx bunderstack blueprint
bunx bunderstack blueprint --check
```

Call `await app.close()` in tests and standalone scripts that own the app.
Queue workers are explicit (`await app.runWorker()`). When a separate worker
publishes realtime changes it must share the Redis Publisher with the web
process.

Examples live in [`examples`](./examples), including Todo, Twitter, Kanban,
TanStack DB, and tldraw applications.

## Development

```sh
bun install
bun run test
bun run typecheck:all
```

## License

MIT
