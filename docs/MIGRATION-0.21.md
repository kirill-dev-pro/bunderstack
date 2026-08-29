# Bunderstack 0.17.x → 0.21.0 — what changed and how to adapt

Bunderstack 0.21 consolidates the multi-package ecosystem into a single `bunderstack` package with clean subpath exports, adds framework-neutral live views with confirmed mutation correlation, introduces direct oRPC CRUD mutation signatures, strengthens realtime SSE streaming with automatic heartbeat recovery, and establishes the modern production server entry contract for TanStack Start and Bun.

---

## The one-paragraph summary

You no longer install `bunderstack-client`, `bunderstack-query`, `bunderstack-sync`, or `bunderstack-start` — everything is imported directly from `bunderstack/<subpath>`. CRUD `update` procedures now take a flat `{ id, ...changes }` payload. Live Views (`bunderstack/client`) provide streaming list subscriptions with native UI bindings for React, Solid, Vue, and Svelte. Realtime SSE streams automatically reconnect on silent network drops via a 5-second heartbeat watchdog and batch cache updates with `notifyScheduler: 'frame'`. Production TanStack Start deployments use `src/server.ts` with `bun dist/server/server.js`.

---

# What Changed

## 1. Single-Package Architecture & Subpath Exports (0.21)

All satellite packages (`bunderstack-client`, `bunderstack-query`, `bunderstack-sync`, `bunderstack-start`) have been merged into `bunderstack`.

### `package.json` Dependencies

```json
// 0.17 - 0.20
{
  "dependencies": {
    "bunderstack": "^0.17.0",
    "bunderstack-query": "^0.17.0",
    "bunderstack-sync": "^0.17.0",
    "bunderstack-start": "^0.17.0"
  }
}

// 0.21
{
  "dependencies": {
    "bunderstack": "^0.21.0"
  }
}
```

### Import Subpaths Mapping

| Previous Import (0.17–0.20) | New Subpath Import (0.21) | Purpose |
|---|---|---|
| `bunderstack` | `bunderstack` | Backend runtime (`createBunderstack`, `provision`, `defineApi`, `buildApiRegistry`) |
| `bunderstack-client` | `bunderstack/client` | Framework-neutral typed RPC client & `createLiveView` |
| `bunderstack-client/rest` | `bunderstack/client-rest` | Type-safe REST client |
| `bunderstack-client/react` | `bunderstack/client-react` | React LiveView hook (`useLiveView`) |
| `bunderstack-client/solid` | `bunderstack/client-solid` | Solid LiveView primitive (`createLiveView`) |
| `bunderstack-client/vue` | `bunderstack/client-vue` | Vue LiveView composable (`useLiveView`) |
| `bunderstack-client/svelte` | `bunderstack/client-svelte` | Svelte LiveView store (`createLiveView`) |
| `bunderstack-query` | `bunderstack/query` | TanStack Query integration (`createClient`, `syncRealtime`) |
| `bunderstack-query/react` | `bunderstack/query-react` | React-specific query helpers |
| `bunderstack-sync` | `bunderstack/sync` | TanStack DB client with realtime collections (`createSyncClient`) |
| `bunderstack-start` | `bunderstack/start` | TanStack Start SSR helpers (`bunderstackStart`, `createApiHandlers`, `getSessionUser`) |
| `bunderstack-start/auth` | `bunderstack/start-auth` | Better Auth client wrapper for TanStack Start |
| `bunderstack/database/*` | `bunderstack/libsql`, `bunderstack/postgres-js`, `bunderstack/bun-sql`, `bunderstack/pglite` | Database adapters |
| `bunderstack/storage/*` | `bunderstack/storage/*` | Storage adapters (`s3`, `disk`) |
| `bunderstack/email/*` | `bunderstack/email-smtp` | SMTP email adapter |
| `bunderstack/jobs/*` | `bunderstack/jobs/*` | Job queue adapters (`memory`, `redis`) |
| `bunderstack/blueprint` | `bunderstack/blueprint` | Blueprint contract validation & parsing |
| `bunderstack/typeid` | `bunderstack/typeid` | TypeID prefix and ID generation utilities |

---

## 2. Direct oRPC CRUD Input Signatures (0.20)

Generated CRUD `update` procedures now accept a flat object containing the `id` and changed fields directly, matching standard oRPC idioms:

```ts
// Before (0.17 - 0.19)
await api.posts.update.call({ id: 'post_123', data: { title: 'New Title' } })

// 0.20+ / 0.21
await api.posts.update.call({ id: 'post_123', title: 'New Title' })
```

The REST transport projection continues to serve `PATCH /api/posts/{id}` with the changed fields in the body and rejects an immutable `id` in the payload.

---

## 3. Live Views with Confirmed Mutation Correlation (0.19 - 0.20)

Bunderstack provides `GET /api/live/{table}` for lightweight, reactive list streaming without TanStack Query or TanStack DB:

```ts
import { createLiveView } from 'bunderstack/client'
import type { Todo } from './schema'

const view = createLiveView<Todo>('/api/live/todos', {
  input: { sort: 'createdAt', order: 'desc', limit: 100 },
})

// Subscribe to row changes and connection status ('connecting' | 'live' | 'stale')
view.subscribe(() => {
  console.log(view.getRows(), view.getStatus())
})

// Optimistic patch (server echo replaces it)
view.patch((rows) => {
  rows[0] = { ...rows[0], done: true }
})

// Teardown
view.close()
```

### React Hook Example

```tsx
import { useLiveView } from 'bunderstack/client-react'

function TodoList() {
  const { rows, status } = useLiveView<Todo>('/api/live/todos', {
    input: { sort: 'createdAt', order: 'desc', limit: 50 },
  })

  return (
    <div>
      <span className="badge">{status}</span>
      <ul>
        {rows.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </div>
  )
}
```

---

## 4. Realtime Stream Resilience & Batching (0.18)

`syncRealtime` from `bunderstack/query` includes built-in heartbeat monitoring and cache notification batching:

```ts
import { syncRealtime } from 'bunderstack/query'

const realtime = syncRealtime({
  api,
  queryClient,
  tables: ['posts', 'comments'],
  // 'frame' batches cache flushes via requestAnimationFrame (default)
  // 'sync' writes immediately on each event
  // number sets a millisecond debounce window
  notifyScheduler: 'frame',
  // 'patch' updates cached list queries in-place when possible; falls back to invalidation
  apply: 'patch',
})
```

- **Heartbeat Watchdog**: The server emits a transport heartbeat every 5 seconds. If no data or heartbeat is received within 2.5 intervals (~12.5 seconds), the client automatically terminates the stalled connection and initiates a reconnect.

---

## 5. TanStack Start & Production Server Entry (0.21)

Modern TanStack Start with Vite compiles client assets to `dist/client` and the SSR handler to `dist/server/server.js`.

### 1. Add `src/server.ts`

Create `src/server.ts` to serve static client assets (`/assets/*`, `.css`, `.js`) from `dist/client` while delegating application routes to `createStartHandler`:

```ts
// src/server.ts
import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { join } from 'node:path'

const handler = createStartHandler(defaultStreamHandler)

export default {
  async fetch(req: Request) {
    const url = new URL(req.url)

    // Serve static client assets from dist/client in production
    if (url.pathname.startsWith('/assets/') || url.pathname.includes('.')) {
      const filePath = join(process.cwd(), 'dist/client', url.pathname)
      const file = Bun.file(filePath)
      if (await file.exists()) {
        return new Response(file)
      }
    }

    return handler(req)
  },
}
```

### 2. Update `package.json` Scripts

Update the `"start"` script to run `dist/server/server.js`:

```json
{
  "scripts": {
    "dev": "bun --bun vite dev",
    "build": "vite build",
    "start": "bun dist/server/server.js"
  }
}
```

### 3. Remove `@tanstack/react-router-ssr-query`

If your router configuration used `setupRouterSsrQueryIntegration`, remove it. Bunderstack applications use standard `QueryClientProvider` and `bunderstack/query`:

```tsx
// src/router.tsx
import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { createApi, createQueryClient } from './api'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = createQueryClient()
  const api = createApi(queryClient)

  return createRouter({
    routeTree,
    context: { queryClient, api, user: null },
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}
```

---

## 6. Migration Checklist

1. **Update `package.json`**:
   - Replace any references to `bunderstack-client`, `bunderstack-query`, `bunderstack-sync`, `bunderstack-start` with `"bunderstack": "^0.21.0"`.
   - Remove `@tanstack/react-router-ssr-query` if present.
   - Set `"start": "bun dist/server/server.js"`.
2. **Update imports across codebase**:
   - `from 'bunderstack-query'` → `from 'bunderstack/query'`
   - `from 'bunderstack-sync'` → `from 'bunderstack/sync'`
   - `from 'bunderstack-start'` → `from 'bunderstack/start'`
   - `from 'bunderstack-client'` → `from 'bunderstack/client'`
3. **Update CRUD update calls**:
   - Change `.update.call({ id, data: changes })` to `.update.call({ id, ...changes })`.
4. **Add `src/server.ts`** in TanStack Start projects.
5. **Run `bun install`** and regenerate the blueprint:
   ```sh
   bun install
   bunx bunderstack blueprint
   ```
6. **Verify build and tests**:
   ```sh
   bun run build
   bun test
   ```
