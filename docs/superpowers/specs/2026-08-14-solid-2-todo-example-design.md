# Solid 2 todo example

A bare-bones SPA mounting Bunderstack in a Solid 2.0 RC application, using
Solid's own async primitives as the entire client data layer.

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

| Decision | Choice | Reason |
| --- | --- | --- |
| Rendering | Client SPA, `start: true` | Simplest shape. No SSR, no server functions, no hydration. |
| Project shape | `bare` | A single page needs no router. Drops `@solidjs/router`, `@solidjs/meta`, and `filesystem-routing`. |
| Dev API mount | Start-mode middleware | One process for app and API. |
| Prod API mount | Own `src/server.ts` | A client-mode build has no request handler, so the example ships an ~18-line `Bun.serve` for static assets plus `app.handler`. |
| Client data | Solid 2 async primitives | The point of the example. No TanStack Query. |
| Features | Auto-CRUD only | No auth, storage, email, jobs, or realtime. `examples/todo` is the full-feature tour. |

The tradeoff of client mode is two mount points: `src/middleware.ts` in dev and
`src/server.ts` in production. Both are a few lines wrapping the same
`app.handler`, and the production server is a file the example wants anyway.

## Architecture

```
dev                                   production
───                                   ──────────
vite dev                              bun src/server.ts
  └─ handleRequest                      ├─ /api/*  → app.handler
       ├─ /api/* → app.handler          ├─ /assets → dist/client
       └─ SPA shell + HMR               └─ *       → dist/client/index.html
                    │                                    │
                    └──── browser: api.todos.*.call() ────┘
```

### The dev mount

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

```ts
// src/server.ts
import { app } from './bunderstack'

const index = Bun.file('./dist/client/index.html')

Bun.serve({
  port: Number(process.env.PORT ?? 3006),
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api')) return app.handler(request)

    const asset = Bun.file(`./dist/client${pathname}`)
    if (await asset.exists()) return new Response(asset)

    return new Response(index, { headers: { 'content-type': 'text/html' } })
  },
})
```

### The client

`createClient<App>({})` is called with no QueryClient. Every procedure carries
`.call(input)`, which is the oRPC client method underneath the TanStack
utilities — the same method `bunderstack-query`'s own realtime module uses.

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

Nothing renders on the server, so `TodoList` is an ordinary import — no
`clientOnly` boundary and no isomorphic fetch.

## Files

```
examples/todo-solid-2/
  package.json          dev on port 3006
  tsconfig.json         jsxImportSource: "@solidjs/web"
  vite.config.ts        solid({ start: { middleware: './src/middleware.ts' } })
  README.md
  src/schema.ts         one todos table, plus export * from 'bunderstack/schema'
  src/access.ts         todos: { crud: true, list/get/create/update/delete: 'public' }
  src/bunderstack.ts    createBunderstack + provision + export type App
  src/middleware.ts     dev mount, the six lines above
  src/server.ts         production server
  src/api.ts            createClient<App>({})
  src/Document.tsx      document shell — optional, sets the title
  src/App.tsx           layout + <TodoList />
  src/TodoList.tsx      createOptimisticStore + action + Loading/Errored
  src/app.css
```

`Document.tsx` exists only to set the page title and favicon; deleting it falls
back to the plugin's built-in shell. It needs no `<HydrationScript />` because
client mode strips that output.

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
- `bun run --cwd examples/todo-solid-2 build`, confirm `dist/` holds only
  `client/`, then `bun src/server.ts` and exercise the same three operations
  against the built app.
- `bun test scripts/` for the boundary tests.
- `bunx tsc --noEmit -p examples/todo-solid-2/tsconfig.json`, added to the root
  `typecheck:examples` script.
- `bun run typecheck` — the `bunderstack-query` type import change.
- Register the example in the root `package.json` scripts and in the run table
  in `examples/README.md`.

## Out of scope

Auth, file uploads, email, jobs, and realtime. Realtime deserves its own
example later: `syncRealtime` invalidates TanStack query keys, so a
query-library-free Solid app would consume the `api.realtime.changes.call()`
async iterable and call `refresh()` directly. SSR, server functions, and server
components are also out of scope; the Solid RC notes flag those integration
seams as still changing.
