# bunderstack-client

Framework-neutral typed oRPC client and confirmed realtime `LiveView` for
Bunderstack. Optional adapters are exported from `bunderstack-client/solid`,
`/react`, `/vue`, and `/svelte`.

TanStack Query and TanStack DB integrations build on this package; the core has
no framework dependency.

```ts
import { createClient, createLiveView } from 'bunderstack-client'
import type { App } from './bunderstack'

const api = createClient<App>()
const todos = createLiveView({
  subscribe: ({ signal }) =>
    api.todos.live(
      { sort: 'createdAt', order: 'desc', limit: 100 },
      { signal },
    ),
})

await todos.mutate(api.todos.create, {
  title: 'Server generates the entity ID',
})
```

The app type carries the oRPC graph, so applications in the same TypeScript
project need no generated route map. Standalone clients that only have an
OpenAPI artifact can use the explicit `bunderstack-client/rest` adapter.

For that separate-repository workflow, generate the small route artifact from
the deployed OpenAPI document and commit or regenerate it with the frontend:

```ts
// scripts/generate-api.ts
import { generateRouteMap } from 'bunderstack/codegen'

const spec = await fetch(`${process.env.API_URL}/api/openapi.json`).then((r) =>
  r.json(),
)
await Bun.write('src/api-routes.ts', generateRouteMap(spec))
```

```ts
import { createRestClient } from 'bunderstack-client/rest'
import { routes, type ApiRoutes } from './api-routes'

export const api = createRestClient<ApiRoutes>(routes, {
  baseUrl: import.meta.env.PUBLIC_API_URL,
})
```

The generated REST surface intentionally excludes `/api/auth/*`.

Better Auth keeps its official framework client. It shares `app.handler` and
the `/api` origin with oRPC, but its `/api/auth/*` protocol is intentionally not
wrapped or duplicated here.

`mutate` automatically sends an opaque `operationId` and waits for the matching
confirmed live frame. If that frame is lost during a disconnect, a fresh
authoritative snapshot settles the successful mutation. A heartbeat watchdog
reconnects silent streams. The client never generates or owns the entity's
database ID.

Framework bridges are intentionally thin:

```ts
import { createLiveStore } from 'bunderstack-client/solid'
import { useLiveView } from 'bunderstack-client/react'
import { useLiveView as useVueLiveView } from 'bunderstack-client/vue'
import { liveStore } from 'bunderstack-client/svelte'
```
