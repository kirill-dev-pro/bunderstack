# Solid 2 todo example

A bare-bones Solid 2.0 RC application that mounts Bunderstack into Solid's own
request handler, using `@tanstack/solid-query` over Bunderstack's generated
query options as the entire client data layer.

> **Revised after implementation.** Three decisions below were superseded
> by what the build and the runtime actually did:
>
> 1. **Serving.** The design specified a client-mode SPA with a hand-written
>    `src/server.ts`. That shipped and worked, but meant two processes split by
>    URL prefix. The example now runs `ssr: true` with the Nitro plugin, so one
>    handler serves pages and `/api` in dev, preview, and production. See
>    [One handler](#one-handler-revised).
> 2. **Client data.** The design used Solid 2's async primitives
>    (`createOptimisticStore` / `action` / `refresh`) with no query library,
>    which required an in-process SSR fetch. The example now uses
>    `@tanstack/solid-query@6` with `bunderstack-query`'s generated query
>    options, and loads the list through `clientOnly` so it never fetches on
>    the server. See [Client data](#client-data-revised).
> 3. **Features.** The design scoped the example to auto-CRUD. It now also
>    declares jobs and realtime, because the streaming-progress showcase needs
>    both. See
>    [2026-08-15-solid-2-streaming-job-progress-design.md](./2026-08-15-solid-2-streaming-job-progress-design.md).

## Why

`examples/kanban-solid-1.9` is the only Solid example. It predates Solid 2 and
carries three files of integration plumbing — a hand-written Vite middleware
plugin, a Nitro config, and a catch-all Nitro route — to put `app.handler` in
front of the page server.

Solid 2 replaces SolidStart with "start mode", a flag on `@solidjs/vite-plugin`
whose stable server contract is fetch-style middleware:

```ts
type Middleware = (
  request: Request,
  next: (request?: Request) => Promise<Response>,
) => Response | Promise<Response>
```

That is `app.handler`'s shape. The dev integration collapses to six lines.

The second reason is the client. Solid 2's headline feature is async in the
reactive graph: `createOptimisticStore`, `action`, `refresh`, and the `Loading`
/ `Errored` boundaries. Together they cover what TanStack Query covers for
CRUD. Bunderstack's generated `api.todos.*` procedures each expose `.call()`, a
plain typed RPC method, so an app can consume the whole API with no query
library at all. No existing example shows this.

That was the original motivation, and it did not survive `ssr: true` — see
[Client data](#client-data-revised). The example still calls `.call()` directly
for its custom procedures; what it no longer does is use the async primitives
as the whole data layer.

## Verified behaviour

Confirmed against a scaffolded `create-solid@0.10.0` project using
`@solidjs/vite-plugin@3.0.0-next.28`, `solid-js@2.0.0-rc.0`, and `vite@8.2.1`,
not inferred from documentation:

- Start-mode middleware intercepts `/api/*` ahead of page serving in dev, in
  client mode.
- A client-mode `vite build` emits `dist/client` with a static `index.html`
  that loads the entry script. It also builds `dist/server` and then **deletes**
  it, so the production output is static assets only and carries no request
  handler. This is why the example ships its own server.
- A `Bun.serve` fronting `dist/client` with an SPA fallback, delegating `/api`
  to a handler, served assets, index, deep links, and the API correctly.
- The Solid dev server returns 404 for `/` unless the request sends
  `Accept: text/html`. This surprises anyone probing it with `curl`; the README
  should say so.

## Decisions

| Decision       | Choice                    | Reason                                                                                                                     |
| -------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rendering      | `ssr: true` + Nitro       | The only shape that keeps one request handler after a build. (Was: client SPA — see the revision note.)                    |
| Project shape  | `bare`                    | A single page needs no router. Drops `@solidjs/router`, `@solidjs/meta`, and `filesystem-routing`.                         |
| Dev API mount  | Start-mode middleware     | One process for app and API.                                                                                               |
| Prod API mount | The same middleware       | Nitro turns Solid's handler into `.output/server/index.mjs`, which serves assets and dispatches `/api` through that chain. |
| Client data    | `@tanstack/solid-query@6` | Bunderstack's generated query options, via the first Query release supporting Solid 2. (Was: Solid 2 async primitives.)    |
| Features       | Auto-CRUD, jobs, realtime | No auth, storage, or email; `examples/todo` is the full-feature tour. (Was: auto-CRUD only — see the revision note.)       |

There is one mount point, `src/middleware.ts`, in every environment. The cost
is that the app server-renders, which is why the client needs an in-process
`fetch` during SSR.

## Architecture

```
dev: vite dev            production: bun .output/server/index.mjs
                     (Nitro, from Solid's handler)
        │                              │
        └────────── handleRequest ─────┘
                         │
             ┌───────────┴────────────┐
             │                        │
      src/middleware.ts          page render (SSR)
      /api/* → app.handler            │
             ▲                        │
             │   in-process, no HTTP  │
             └────────────────────────┘
                         │
        browser ── /api ── api.todos.*.call()
```

### The mount

```ts
// src/middleware.ts — server-only module, never bundled for the browser
import { app } from './bunderstack'

export default [
  async (request: Request, next: () => Promise<Response>) =>
    new URL(request.url).pathname.startsWith('/api')
      ? app.handler(request)
      : next(),
]
```

```ts
// vite.config.ts
solid({ start: { middleware: './src/middleware.ts' } })
```

### The production server

Superseded — see [One handler (revised)](#one-handler-revised). Production runs
`.output/server/index.mjs`, built by Nitro from Solid's handler.

### The client

Superseded — see [Client data (revised)](#client-data-revised). The original
design read as follows.

```tsx
const [todos, setTodos] = createOptimisticStore<Todo[]>(
  async () => api.todos.list.call({ limit: 100 }),
  [],
)

const toggle = action(function* (id: string, done: boolean) {
  setTodos((draft) => {
    const todo = draft.find((candidate) => candidate.id === id)
    if (todo) todo.done = done
  })
  try {
    yield api.todos.update.call({ id, done })
  } finally {
    refresh(todos)
  }
})
```

The optimistic write is visible immediately, reverts if the call rejects, and
`refresh` reconciles against the server. `<Loading>` renders the first-load
fallback; `<Errored>` renders a retry. No loading flags, no rollback handlers.

`TodoList` is loaded through `clientOnly`, so it never runs during SSR and its
queries always have a browser origin.

## Files

```
examples/todo-solid-2/
  package.json          dev on port 3006
  tsconfig.json         jsxImportSource: "@solidjs/web"
  vite.config.ts        solid({ start: { middleware }, ssr: true }) + nitro()
  README.md
  src/bunderstack.ts    tables + access rules + jobs + custom api + export type App
  src/provision.ts      provision(app) + first-run seed, run by dev and start
  src/fake-llm.ts       the stand-in token generator
  src/middleware.ts     the mount, the six lines above
  src/api.ts            QueryClient + createClient<App>({ queryClient })
  src/Document.tsx      document shell — optional, sets the title
  src/App.tsx           layout + <TodoList />
  src/TodoList.tsx      useQuery/useMutation + syncRealtime
  src/app.css
```

`Document.tsx` sets the page title and must render `<HydrationScript />`;
deleting the file falls back to the plugin's built-in shell.

Dependencies: `solid-js@2.0.0-rc.0`, `@solidjs/web@2.0.0-rc.0`,
`@solidjs/vite-plugin@3.0.0-next.28` (dev), `vite@^8`, `bunderstack`,
`bunderstack-query`, and `bunderstack-query`'s oRPC peers.

## Package change

`bunderstack-query` is framework-neutral at runtime. Its only React coupling is
a single type import in `packages/bunderstack-query/src/client.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query'
```

`src/realtime.ts` already imports the same type from `@tanstack/query-core`,
and `src/react.tsx` is a pure re-export that imports nothing from React. The
change:

1. `client.ts` imports `QueryClient` from `@tanstack/query-core`.
2. `package.json` moves the `@tanstack/react-query` peer to
   `@tanstack/query-core`.
3. `scripts/dependency-boundaries.test.ts` updates the two assertions that pin
   the current import (the `query client keeps QueryClient type-only` test) and
   the `@tanstack/react-query` peer (in `manifests declare correct peers and
dependencies`).

Without this, a Solid example would have to install `@tanstack/react-query` so
TypeScript can resolve a type it never uses.

The change is source-compatible: `@tanstack/react-query` imports `QueryClient`
from `@tanstack/query-core` and re-exports it, so it is the same type and React
consumers continue to typecheck. `bunderstack-sync` and `bunderstack-start`
keep their React peers — they are React packages.

## Verification

- `bun run dev:todo-solid-2`, then add, toggle, and delete a todo.
- `bun run --cwd examples/todo-solid-2 build`, then `bun run ... start` and
  exercise the same three operations against the built app, confirming the
  page, its assets, and `/api` all come from the one process.
- `bun test scripts/` for the boundary tests.
- `bunx tsc --noEmit -p examples/todo-solid-2/tsconfig.json`, added to the root
  `typecheck:examples` script.
- `bun run typecheck` — the `bunderstack-query` type import change.
- Register the example in the root `package.json` scripts and in the run table
  in `examples/README.md`.

## One handler (revised)

The shipped architecture, and the evidence behind it. Each row was tested, not
inferred.

| Setup                                                                  | Single handler?                                                                                                                   | Assets served?                             | Hand-written server? |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------- |
| client mode                                                            | dev only — build deletes `dist/server`                                                                                            | n/a                                        | yes                  |
| client mode + `serverFunctions`, run `dist/server/server.js` under Bun | yes                                                                                                                               | **no** — asset paths return the HTML shell | no                   |
| client mode + `serverFunctions`, `vite preview`                        | no — the SPA fallback answers API `GET`s before the handler                                                                       | yes                                        | no                   |
| client mode + Nitro                                                    | **build fails** — the plugin imports `dist/server/server.js` to prerender the shell, which Nitro has redirected to its own output | n/a                                        | n/a                  |
| **`ssr: true` + Nitro**                                                | **yes**                                                                                                                           | **yes**                                    | **no**               |

The built server entry is a Fetchable module (`export default { fetch }`,
plus a named `handleRequest`), which Bun can run directly — but it does not
serve `dist/client`, so a bare `bun dist/server/server.js` leaves the page
without its JavaScript. Nitro adopts Solid's `ssr` environment, adds static
asset serving, and produces `.output/server/index.mjs`.

`ssr: true` then makes the client run on the server, where a relative
`/api/rpc` has no origin. Rather than reintroduce HTTP, `src/api.ts` passes a
server-side `fetch` that hands the Request to `app.handler` in process, behind
the build-time `isServer` constant. The first render arrives with data, and
there is no `APP_URL` to configure.

Two further requirements surfaced only at runtime:

- `Document.tsx` must render `<HydrationScript />`. Without it the server
  render succeeds and hydration dies with `_$HY is not defined`.
- Vite must run under Bun (`bun --bun vite`). Under Node the reads work and
  the writes fail with an opaque 500.

## Client data (revised)

The original design consumed `.call()` inside `createOptimisticStore` and
treated "no query library" as the point of the example. Under `ssr: true` that
required a server-side `fetch` that handed the Request to `app.handler` in
process — elegant, but it put transport plumbing in `src/api.ts`.

`@tanstack/solid-query@6.0.0-rc.0` is the first Query release whose peer range
admits Solid 2 (`solid-js >=2.0.0-rc.0 <3.0.0`), so `bunderstack-query`'s
primary interface — typed `queryOptions` / `mutationOptions` / `key` builders —
is available to Solid exactly as it is to React. `src/api.ts` becomes:

```ts
export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })
```

Choosing this means the list is browser-only: a query running during SSR has no
origin to fetch from. `App.tsx` loads `TodoList` through Solid's `clientOnly`,
so the server renders the shell and the browser mounts the component. The
server-rendered data from the previous revision is given up deliberately in
exchange for a client with no transport code in it.

This also makes realtime a small addition rather than a rewrite: `syncRealtime`
drives a TanStack Query cache, which the example now has.

Note that this does not replace the Solid start-mode integration with TanStack
Start for Solid. That release (`@tanstack/solid-start@2.0.0-beta.12`) is a
metaframework that would displace start mode and Nitro, and it pins
`solid-js@^2.0.0-beta.5` — older than the `2.0.0-rc.0` this example targets.

## Realtime (added)

Realtime was originally deferred on the grounds that `syncRealtime` is
QueryClient-coupled. With the client now on TanStack Solid Query that objection
is gone, but the example wires it by hand anyway, because the hand-wired
version is the showcase: `api.realtime.changes.call()` resolves to an async
iterable, and a Solid 2 computation can return an async iterable directly, so
the SSE stream is a reactive source rather than a subscription with a lifecycle.

Two things this surfaced:

- The patching logic moved into `bunderstack-query` as
  `syncRealtime({ apply: 'patch' })`, since it is uniform across CRUD tables
  and needs only a QueryClient. It patches update and delete unconditionally,
  inserts creates at the position the cached `sort`/`order` implies, and falls
  back to invalidating any list where membership or position is undecidable —
  a `q` search, or a page that is not the complete result. The example now
  calls that instead of hand-rolling it.
- The cache is patched from the event rather than invalidated. The change
  carries the action and a fully deserialized record, so `setQueryData` applies
  it directly and a write costs one request instead of two. Mutations have no
  `onSuccess` either — the write returns over the stream, and invalidating as
  well would fire a refetch the stream's update then cancels.
- Patching by hand encodes the list's shape (sorted by `createdAt` descending,
  a single page) and misses events while the stream is down. `syncRealtime`
  trades that precision for invalidation, which is the right default for lists
  with filters or pagination.
- `bun --bun vite` does not run Vite under Bun; it execs
  `node node_modules/.bin/vite`. Only `bun --bun ./node_modules/vite/bin/vite.js`
  keeps Bun. Under Node, Bunderstack returns srvx's `NodeResponse`, which is not
  a `Response` instance, and Solid's middleware rejects it — RPC writes 500
  while REST reads succeed.
- `createEffect` takes a compute function _and_ an effect function in Solid 2.
  A single function throws `[MISSING_EFFECT_FN]`. This is what replaced `on()`.
- Vite's dev server can evaluate `src/bunderstack.ts` more than once, giving
  each evaluation its own in-memory publisher, so a write publishes where no
  subscriber listens. Realtime then works in production and silently fails in
  dev. The app is cached on `globalThis` to keep one instance per process.

## Out of scope

Auth, file uploads, email, jobs, and realtime. Realtime deserves its own
example later: `syncRealtime` invalidates TanStack query keys, so a
query-library-free Solid app would consume the `api.realtime.changes.call()`
async iterable and call `refresh()` directly. SSR, server functions, and server
components are also out of scope; the Solid RC notes flag those integration
seams as still changing.
