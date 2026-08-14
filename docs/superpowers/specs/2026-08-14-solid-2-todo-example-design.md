# Solid 2 todo example

A bare-bones example mounting Bunderstack in a Solid 2.0 RC application, using
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

That is `app.handler`'s shape. The integration collapses to six lines that work
identically in dev, preview, and production.

The second reason is the client. Solid 2's headline feature is async in the
reactive graph: `createOptimisticStore`, `action`, `refresh`, and the `Loading`
/ `Errored` boundaries. Together they cover what TanStack Query covers for
CRUD. Bunderstack's generated `api.todos.*` procedures each expose `.call()`, a
plain typed RPC method, so an app can consume the whole API with no query
library at all. No existing example shows this.

## Verified behaviour

The following were confirmed against a scaffolded `create-solid@0.10.0` project
using `@solidjs/vite-plugin@3.0.0-next.28`, `solid-js@2.0.0-rc.0`, and
`vite@8.2.1`, not inferred from documentation:

- Start-mode middleware intercepts `/api/*` ahead of page rendering in dev,
  in both client mode and SSR mode.
- With `ssr: true`, `vite build` emits `dist/server/server.js` exporting
  `handleRequest`. Served under `Bun.serve`, that single handler returned both
  the server-rendered page and the middleware's `/api` response.
- With `ssr` off and no server functions, the build emits `dist/server` and
  then **deletes** it. A client-mode production build is static-only and its
  API would 404. This is why the example enables `ssr: true`.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Rendering | `ssr: true` | The only client-shape configuration whose production build retains a request handler, so dev and prod share one serving path. |
| Project shape | `bare` + SSR | A single page needs no router. Drops `@solidjs/router`, `@solidjs/meta`, and `filesystem-routing`. |
| Client data | Solid 2 async primitives | The point of the example. No TanStack Query. |
| SSR data | None — `clientOnly` | A relative `/api` URL does not resolve on the server. Isomorphic fetch is real work that would dominate a bare-bones example; `examples/todo` already carries the SSR data story. |
| Features | Auto-CRUD only | No auth, storage, email, jobs, or realtime. `examples/todo` is the full-feature tour. |

## Architecture

```
vite dev  /  bun dist/server/server.js
        │
        └─ handleRequest(request)                    one entry, two branches
             ├─ src/middleware.ts  → /api/*  → app.handler        (server only)
             └─ page render        → Document > App > clientOnly(TodoList)
                                                          │
   browser ─────────── POST /api/rpc ─────────────────────┘
                       api.todos.*.call()
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
solid({ start: { middleware: './src/middleware.ts' }, ssr: true })
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

Because the data is browser-only, `TodoList` is wrapped in `clientOnly()` from
`@solidjs/web`. SSR renders the document and the `Loading` fallback; the browser
mounts the list.

## Files

```
examples/todo-solid-2/
  package.json          port 3006
  tsconfig.json         jsxImportSource: "@solidjs/web"
  vite.config.ts        solid({ start: { middleware }, ssr: true })
  README.md
  src/schema.ts         one todos table, plus export * from 'bunderstack/schema'
  src/access.ts         todos: { crud: true, list/get/create/update/delete: 'public' }
  src/bunderstack.ts    createBunderstack + provision + export type App
  src/middleware.ts     the six lines above
  src/api.ts            createClient<App>({})
  src/Document.tsx      html shell + <HydrationScript />
  src/App.tsx           layout + clientOnly(TodoList)
  src/TodoList.tsx      createOptimisticStore + action + Loading/Errored
  src/app.css
```

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

The change is source-compatible: `@tanstack/react-query` re-exports
`QueryClient` from `@tanstack/query-core`, so React consumers passing a
`QueryClient` continue to typecheck. `bunderstack-sync` and `bunderstack-start`
keep their React peers — they are React packages.

## Verification

- `bun run dev:todo-solid-2`, then add, toggle, and delete a todo.
- Request `/` with `Accept: text/html` and confirm the shell renders
  server-side. (A request without that header returns 404 from the Solid dev
  server — expected, not a bug.)
- `vite build` and confirm `dist/server/server.js` exists, then serve it and
  confirm `/api/rpc` responds.
- `bun test scripts/` for the boundary tests.
- `bunx tsc --noEmit -p examples/todo-solid-2/tsconfig.json`, and add that to
  the root `typecheck:examples` script.
- `bun run typecheck` — the `bunderstack-query` type import change.

## Out of scope

Auth, file uploads, email, jobs, and realtime. Realtime deserves its own
example later: `syncRealtime` invalidates TanStack query keys, so a
query-library-free Solid app would consume the
`api.realtime.changes.call()` async iterable and call `refresh()` directly.
Server functions and server components are also out of scope; the Solid RC
notes flag those integration seams as still changing.
