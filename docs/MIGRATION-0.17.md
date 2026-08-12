# Bunderstack 0.16.x → 0.17.0 — what changed and how to adapt

0.17 replaces tRPC with [oRPC](https://orpc.dev) and collapses CRUD, storage,
realtime, and your own procedures into **one procedure graph** served over two
transports: RPC at `/api/rpc/*` and REST/OpenAPI at `/api/*`. One router, one
context, one error vocabulary, one name per table.

This is the most breaking release so far. Everything below is mechanical; the
order is the order we recommend doing it in.

> Versions: this guide covers `0.17.0-beta.2`. Items marked **(beta.2)** changed
> after `beta.0`/`beta.1`, so read those even if you already migrated to an
> earlier beta.

## The one-paragraph summary

`trpc:` becomes `api:`, `.query()`/`.mutation()` become `.handler()`, `ctx`
becomes `context`, and procedures are plain oRPC — so anything oRPC can do
(OpenAPI routes, typed errors, event iterators) is available without a wrapper.
On the client, `bunderstack-query` exposes oRPC's own TanStack Query utilities
(`queryOptions({ input })`, `key()`, `infiniteOptions`), and `bunderstack-sync`
builds TanStack DB collections on top of them. Generated `list` now takes a
typed, nested `filters` object instead of loose flat params.

---

# Application migration

## 1. `trpc:` → `api:`, and procedures are oRPC

```ts
// 0.16
const app = await createBunderstack({
  schema,
  trpc: (t) => ({
    stats: t.protected.input(z.object({})).query(async ({ ctx }) => {
      return { users: await ctx.db.$count(schema.user) }
    }),
  }),
})

// 0.17
const app = await createBunderstack({
  schema,
  api: (o) => ({
    stats: o.protected
      .input(v.object({}))
      .output(v.object({ users: v.number() }))
      .handler(async ({ context }) => {
        return { users: await context.db.$count(schema.user) }
      }),
  }),
})
```

- `t` → `o`, `.query`/`.mutation` → `.handler`, `ctx` → `context`.
- `o.public`, `o.protected`, `o.webhook` stay as the three entry builders.
- Add `.output(...)` to every procedure you want in the OpenAPI document; oRPC
  cannot describe a response it has no schema for.
- Validation is Standard Schema: valibot, zod, arktype all work. The bundled
  OpenAPI generator only knows how to convert valibot, so a zod-only procedure
  is served fine but omitted from the spec unless you register a converter.

To attach a REST route to your own procedure:

```ts
o.public
  .route({ method: 'POST', path: '/api/webhooks/stripe', tags: ['webhooks'] })
  .input(v.unknown())
  .output(v.object({ ok: v.boolean() }))
  .handler(async ({ context }) => ({ ok: true }))
```

## 2. Shared middleware needs `ApiContext` **(beta.2)**

`ApiContext` is now exported, so middleware can be declared over the real app
context instead of a hand-written minimum:

```ts
import { os } from '@orpc/server'
import type { ApiContext } from 'bunderstack'

const instrumentation = os
  .$context<ApiContext<typeof schema>>()
  .middleware(async ({ context, next, path }) => {
    const started = performance.now()
    const result = await next()
    context.jobs // fully typed
    console.log(path.join('.'), performance.now() - started)
    return result
  })
```

Do **not** wrap the builder in your own generic (`<T extends builder['public']>`)
— that collapses the protected builder to the public one and silently drops
`user` from the context.

## 3. Generated `list` takes typed, nested `filters` **(beta.2)**

Filters, sorting, and paging are now declared by a per-table schema derived from
your `access` config. Values are coerced from query strings by oRPC itself.

```ts
// 0.16 and beta.0/beta.1 — flat params, filters invented client-side
api.posts.list.queryOptions({ input: { authorId: 'u1', limit: 20 } })
GET /api/posts?authorId=u1&limit=20
GET /api/posts?id=a,b,c            // comma-separated IN

// 0.17.0-beta.2
api.posts.list.queryOptions({ input: { filters: { authorId: 'u1' }, limit: 20 } })
GET /api/posts?filters[authorId]=u1&limit=20
GET /api/posts?filters[id][]=a&filters[id][]=b   // list → IN
GET /api/posts?filters[deletedAt]=null           // → IS NULL
```

What this fixes and changes:

- `?offset=` and `?count=` work over REST (they used to fail validation), as do
  numeric, boolean, and date filters — `?filters[createdAt]=2026-06-01` arrives
  as a `Date`.
- A bare query param is no longer a filter. `?authorId=u1` is now a 400; only
  `filters` reaches the WHERE clause. This also closes the case where a raw URL
  param bypassed the procedure schema entirely.
- Comma-separated `IN` (`?column=a,b,c`) is gone — pass a list instead.
- `filters` is typed per table: unknown columns and wrong value types are
  **compile errors** in the client, and appear as real parameters in OpenAPI.
- A filterable column may now be named `limit`, `sort`, `q`, … — nesting removed
  the collision, so the config error that used to reject those is gone.
- `?limit=` is still clamped to 200 silently; `?limit=0` or `?limit=abc` is 400.

Adopt it by listing the columns you want filterable, as before:

```ts
access: {
  posts: { list: 'public', filterableColumns: ['authorId', 'published'] },
}
```

## 4. Error codes are oRPC's codes **(beta.2)**

`VALIDATION_ERROR` → `BAD_REQUEST`, `RATE_LIMITED` → `TOO_MANY_REQUESTS`. The
other five (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`PAYLOAD_TOO_LARGE`) already matched oRPC and are unchanged.

```ts
// 0.16 / beta.1
if (error.code === 'VALIDATION_ERROR') { … }
// beta.2
if (error.code === 'BAD_REQUEST') { … }
```

Why it matters beyond the rename: statuses now come from oRPC's own map, so
**client mistakes answer 4xx instead of 500**. In beta.0/beta.1 every schema
failure and every rate-limit rejection answered HTTP 500 with a 4xx code in the
body — on both REST and RPC. If you built alerting on 5xx rate, expect it to
drop; if you special-cased those 500s, remove that.

Validation failures now also carry the offending field:

```json
{ "error": "Input validation failed", "code": "BAD_REQUEST",
  "details": [{ "path": ["filters", "likes"], "message": "Invalid type: …" }] }
```

## 5. Realtime names tables by their schema key **(beta.2)**

Events and subscriptions use the **schema key** — the same name you call
procedures with — not the SQL table name:

```ts
// schema
export const creditBalances = sqliteTable('credit_balances', { … })

// 0.17.0-beta.0/beta.1: procedures were `creditBalances`, events said
// `credit_balances`, and no single name worked for both.
// beta.2: one name.
await client.realtime.changes({ tables: ['creditBalances'] })
// event: { table: 'creditBalances', action: 'create', record: { … } }
```

If your schema keys equal your table names, nothing changes. If they differ,
replace SQL names with schema keys in every `tables:` subscription and in code
that switches on `change.table`. REST paths are unchanged and still use the SQL
name (`GET /api/credit_balances`).

`app.realtime.publish(table, action, record)` is unchanged — pass the drizzle
table as before; the facade maps it to the key.

## 6. Client: `bunderstack-query` is oRPC's TanStack utilities

```ts
// 0.16
useQuery(api.posts.list.queryOptions({ limit: 20 }, { staleTime: 5_000 }))
queryClient.invalidateQueries({ queryKey: api.posts.list.keys.all })

// 0.17
useQuery(api.posts.list.queryOptions({ input: { limit: 20 }, staleTime: 5_000 }))
queryClient.invalidateQueries({ queryKey: api.posts.list.key() })
```

- `queryOptions(input, opts)` → `queryOptions({ input, ...opts })`.
- `keys.all` → `key()`. `key({ input })` matches partially and deeply, so
  `key({ input: { filters: { authorId } } })` invalidates every list scoped to
  that author regardless of `limit`/`sort`.
- `listQuery` / `getQuery` helpers are gone — use `queryOptions` on the
  procedure, and `infiniteOptions` for cursor paging.
- Sort arrays you pass in filters: `['a','b']` and `['b','a']` are different
  query keys.

## 7. Client: `bunderstack-sync` collections

```ts
// beta.0/beta.1
const feed = posts.scopedCollection({ filter: { replyToId: null } })
// beta.2 — one word for the same thing, everywhere
const feed = posts.scopedCollection({ filters: { replyToId: null } })
```

`table.list(input)` now forwards `input` to the procedure unchanged, so it takes
the same nested shape as everything else **(beta.2)**.

## 8. Packages ship strict-clean sources **(beta.2)**

`exports` still points at `src/**.ts`, so your `tsconfig` checks our sources.
Type-probe files are no longer published, and the packages build under
`noUnusedLocals`, so a consumer with that flag no longer sees errors from
`node_modules/bunderstack`. If you added `skipLibCheck` hoping to silence those,
it never applied — these are real `.ts` files, not declarations.

## 9. Carried over from 0.16 — check these if you skipped it

- Cron handlers take `(invocation, ctx)`, not `(ctx)`. Old code still compiles
  and silently receives the wrong argument. Grep for `handler: async (ctx)`.
- `manifest.background.cron` includes `bunderstack:storage-sweep`, which breaks
  exact-equality assertions in tests.
- `envSource` → `processEnv`; `bunderstack/cron` exports slot helpers now.

See [MIGRATION-0.16.md](./MIGRATION-0.16.md) for the full 0.16 list.

## Application migration checklist

- [ ] `trpc:` → `api:`; `.query`/`.mutation` → `.handler`; `ctx` → `context`
- [ ] `.output(...)` added to every procedure you want documented
- [ ] `queryOptions({ input, ...opts })`; `keys.all` → `key()`
- [ ] `list` inputs nested under `filters`; comma-`IN` replaced with lists
- [ ] `VALIDATION_ERROR` → `BAD_REQUEST`, `RATE_LIMITED` → `TOO_MANY_REQUESTS`
- [ ] realtime `tables:` use schema keys
- [ ] `scopedCollection({ filters })`
- [ ] alerting no longer expects 500s for client errors
- [ ] `bun run typecheck` clean with your own strict flags

---

# Platform migration (Bunderhost)

Nothing in the deploy contract changed in 0.17: same `manifest`, same
`BUNDERSTACK_ROLE`, same single-process model as 0.16. Two operational notes:

- **Error-rate dashboards.** Client errors moved from 500 to 4xx (§4). A drop in
  5xx after upgrading an app is expected, not a monitoring outage.
- **SSE.** `/api/realtime` is an oRPC event iterator with a 5s heartbeat and
  `Last-Event-ID` resume. Proxies must not buffer it; idle timeouts should be
  above the heartbeat interval.

---

## Reference

- Design: [`docs/plans/2026-08-11-orpc-simplification-design.md`](./plans/2026-08-11-orpc-simplification-design.md)
- oRPC docs: <https://orpc.dev>
- TanStack Query integration: <https://orpc.dev/docs/integrations/tanstack-query>
