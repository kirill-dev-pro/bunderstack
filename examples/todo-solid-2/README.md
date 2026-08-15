# Todo — Solid 2 + Bunderstack

A todo list on Solid 2.0 RC with **no second server**: Bunderstack is mounted
into Solid's own request handler, the client is TanStack Solid Query driven by
Bunderstack's generated query options, and realtime arrives as an **async
iterable read straight from the reactive graph**.

```bash
bun run dev:todo-solid-2   # http://localhost:3006
```

Eight source files, one table, no auth. The whole backend — schema, access
rules, and app — is `src/bunderstack.ts`. `dev` provisions the database and
then starts Vite, so one command is the whole loop.

## One handler

Solid 2 replaced SolidStart with "start mode", a flag on `@solidjs/vite-plugin`
whose server contract is fetch-style middleware:

```ts
type Middleware = (request: Request, next: () => Promise<Response>) => Response
```

That is already `app.handler`'s shape, so mounting Bunderstack is a path check:

```ts
// src/middleware.ts
import { app } from './bunderstack'

export default [
  async (request: Request, next: () => Promise<Response>) => {
    if (!new URL(request.url).pathname.startsWith('/api')) return next()
    return app.handler(request)
  },
]
```

```ts
// vite.config.ts
solid({ start: { middleware: './src/middleware.ts' }, ssr: true })
nitro({ serverEntry: false, preset: 'bun' })
```

That is the whole integration. The same chain runs in `vite dev`, in
`vite preview`, and inside the built server, so pages and `/api` are served by
one handler in one process everywhere — not two servers split by URL prefix.

Compare `examples/kanban-solid-1.9`, which needs a hand-written Vite plugin, a
Nitro config, and a catch-all Nitro route to do the same job on Solid 1.9.

### Why `ssr: true`

It is what keeps the handler alive after a build. In client mode `vite build`
emits `dist/server` and then **deletes** it, leaving static assets and no way
to serve `/api` without writing your own server. With `ssr: true`, Nitro adopts
Solid's `ssr` environment and turns its handler into
`.output/server/index.mjs`, which serves the built assets and dispatches
everything else through the same middleware chain.

## The client

`bunderstack-query` reads the server's `App` type and returns TanStack Query
option builders for every table and procedure, so `src/api.ts` is the whole
setup:

```ts
export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })
```

`@tanstack/solid-query@6` is the first release that supports Solid 2 — its peer
range is `solid-js >=2.0.0-rc.0`. Components then use the ordinary hooks, with
no URLs and no hand-written query keys:

```tsx
const todos = useQuery(() =>
  api.todos.list.queryOptions({ input: { limit: 100 } }),
)

const toggle = useMutation(() => ({
  mutationFn: (input: { id: string; done: boolean }) =>
    api.todos.update.call({
      params: { id: input.id },
      query: {},
      headers: {},
      body: { done: input.done },
    }),
  onSuccess: () =>
    qc.invalidateQueries({ queryKey: api.todos.key({ type: 'query' }) }),
}))
```

The list is browser-only, so `App.tsx` loads it through Solid's `clientOnly`:
the server renders the shell and the browser mounts the component with an
origin it can fetch from.

```tsx
const TodoList = clientOnly(() => import('./TodoList'))
```

## Realtime, in one call

`realtime: true` on the server broadcasts every CRUD write over SSE, and
`syncRealtime` consumes it:

```tsx
const realtime = syncRealtime<App>({
  api,
  queryClient: qc,
  tables: ['todos'],
  apply: 'patch',
})
onCleanup(() => realtime.close())
```

Passing `App` checks `tables` against the schema — `'todoz'` is a compile
error — and types every change's record as the todo row.

That is the whole client side. `syncRealtime` owns the subscription, the
reconnect loop, and Publisher-ID resumption, and `apply: 'patch'` writes each
change straight into the cached lists rather than refetching them.

**A write costs one request.** Create, update, and delete each fire a single
mutation and no `list` — check the network panel. The mutations have no
`onSuccess` either: the write comes back over the stream, so invalidating there
as well would fire a refetch the stream's update then cancels.

Patching is safe to turn on generally because it degrades rather than guesses.
Bunderstack's list contract is narrow — a filter is `=`, `IN`, or `IS NULL`,
and ordering is one column — so membership and position are decidable from the
cached list and the record. Where they are not, a text search or a page that is
not the whole result, that list is invalidated instead. See
`packages/bunderstack-query/README.md`.

Under the hood the stream is an async iterable, which Solid 2 could also
consume directly as a reactive source — a computation can return an async
iterable, so `createMemo(() => stream)` makes SSE just another value in the
graph. This example used to do exactly that before the logic moved into the
package, where every framework gets it.

## Streaming job progress

Click **Summarise every todo** and a background job generates a summary for
each row one word at a time.

There is no progress channel and no progress table. Bunderstack's only realtime
event is "a row changed", so the job simply writes:

```ts
summary += (summary ? ' ' : '') + randomWord()
const [row] = await ctx.db
  .update(todos)
  .set({ summary })
  .where(eq(todos.id, id as never))
  .returning()
await ctx.realtime.publish(todos, 'update', row)
```

**Each publish carries the whole accumulated text**, so the row _is_ the state
of the stream — open a second tab mid-run, or refresh, and it picks up exactly
where the first left off with no replay logic. The alternative, a row per
token, would make the table unbounded and turn reconnection into a replay
problem.

**Progress is derived, not stored.** `summaryStatus` moves `idle → queued →
streaming → done` (or `failed` from the job's `onFailed`), and the client
counts rows rather than reading a run record. Every state a separate progress
table would have held lives on the rows being changed.

**The columns are server-owned.** `writableColumns: ['title', 'done']` in the
access rules means the generated PATCH route silently drops client writes to
`summary` and `summaryStatus`, while realtime still streams them to every
client allowed to read the row.

**The worker runs in this process.** Declaring `jobs` starts it automatically
(`BUNDERSTACK_ROLE` defaults to `all`), which is also what makes the progress
visible: a worker in a separate process could not reach this one's in-memory
broker without Redis. Bunderstack says so directly if you try —
`runWorker() cannot deliver realtime events through the in-memory broker`.

**Writes through `ctx.db` broadcast explicitly.** Broadcast-on-write lives in
the generated CRUD layer, so a job writing directly with `ctx.db` publishes its
own event. Same event shape, so the client cannot tell the difference.

Starting a run is one custom oRPC procedure (`api.enrich`) that flips every
`idle` row to `queued` and calls `ctx.jobs.enqueue`. Claiming the rows there
rather than in the handler is what makes a second click a no-op instead of a
duplicate run.

The generator in `src/fake-llm.ts` is deliberately fake — no API key, no
network. What this example demonstrates is what happens to a token _after_ it
exists.

### What re-renders

Measured with a render counter against a live stream: rows the job is not
touching are never recreated, but each streaming row's `<li>` is rebuilt on
every token. `bunderstack-query`'s patch path replaces the matched row with the
incoming record, and Solid's `<For>` keys by reference, so a new object means a
new row.

A write costs one row's DOM, not the list's. That is the real property here —
not per-text-node updating.

## Files

| File                              | What it does                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| `src/bunderstack.ts`              | The whole backend — tables, access rules, realtime, a job, one procedure |
| `src/provision.ts`                | Creates or migrates the database, seeds a fresh one, then exits          |
| `src/fake-llm.ts`                 | The stand-in token generator — no key, no network                        |
| `src/middleware.ts`               | The mount, above                                                         |
| `src/api.ts`                      | QueryClient + the typed client — two lines                               |
| `src/TodoList.tsx`                | The data layer, above — loaded via `clientOnly`                          |
| `src/App.tsx`, `src/Document.tsx` | Shell — `Document.tsx` replaces `index.html`                             |

## Production

```bash
bun run --cwd examples/todo-solid-2 build
bun run --cwd examples/todo-solid-2 start   # provisions, then serves
```

`start` runs `.output/server/index.mjs`, which Nitro built from Solid's
handler. Point the preset at another host to deploy elsewhere; see
[nitro.build/config](https://nitro.build/config).

Set `AUTH_SECRET` when `NODE_ENV=production` — Bunderstack requires it there
even though this example configures no auth.

## Things this example learned the hard way

- **Run Vite under Bun — and check that you actually are.** `bun --bun vite`
  and `bun --bun x vite` both hand off to `node node_modules/.bin/vite`; only
  running the entry file, `bun --bun ./node_modules/vite/bin/vite.js`, keeps
  the Bun runtime. Under Node, Bunderstack returns srvx's fast `NodeResponse`,
  which is not a real `Response` instance, and Solid's middleware rejects it —
  a 500 on RPC writes while REST reads keep working. `pgrep -fl vite` tells you
  which runtime you got.
- **Provision outside the app module.** `src/provision.ts` calls
  `provision(app)`; `src/bunderstack.ts` does not. Vite's dev server imports
  the app module to answer `/api`, and drizzle-kit — which the dev-time schema
  push needs — does not resolve inside Vite's module runner.
- **`createEffect` takes two functions in Solid 2** — a compute half that
  tracks and an effect half that applies. Passing one throws
  `[MISSING_EFFECT_FN]` and halts the reactive system. This replaced `on()`.
- **`onMount` is gone.** Components run once, so run setup in the body and pair
  it with `onCleanup`.
- **`<HydrationScript />` is required in `Document.tsx`.** Without it the page
  renders on the server and then dies on hydration with `_$HY is not defined`.
  The dev server still logs that error to the console even when the script is
  present; the production build is clean, so it is an RC dev-mode artifact.
- **Nitro needs `ssr: true`.** In client mode the Solid plugin imports
  `dist/server/server.js` to prerender the static shell, but Nitro redirects
  that build to its own output, so the build fails.
- **Cache the app on `globalThis`.** Vite's dev server can evaluate
  `src/bunderstack.ts` more than once, and each evaluation builds its own
  in-memory realtime publisher. Without the cache, a write publishes to a
  broker no subscriber is listening to: realtime works in production and
  silently does nothing in dev. This one cost the most time to find, because
  nothing errors.

## Notes

- Solid's dev server returns **404 for `/` unless the request sends
  `Accept: text/html`**. `curl http://localhost:3006/` looks broken; it is not.
- Solid 2 is a release candidate. `solid-js` and `@solidjs/web` are pinned to
  `2.0.0-rc.0` and `@solidjs/vite-plugin` to `3.0.0-next.28`, because the RC
  packages are only compatible in matched sets.
- `examples/kanban-solid-1.9` shows the same `syncRealtime` on Solid 1.9 with
  the default `invalidate` strategy.

## What this example leaves out

Auth, file uploads, email, background jobs, realtime, and custom oRPC
procedures. `examples/todo` is the same domain with all of them.
