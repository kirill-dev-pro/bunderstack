# Runtime integrations

A Bunderstack 1.0 app runs on the Workers runtime: Cloudflare in production,
celld on a VPS, and workerd under `bunderstack dev`. The app does not write
Worker code. `app.handler` is still the single Web Standard
`Request -> Response` integration point, and a package Worker entry mounts it.

## App layout

```
src/bunderstack.ts   backend: schema, auth, access, storage, jobs, cron
src/api.ts           the typed client
src/routes/...       TanStack Start routes, loaders, server functions
vite.config.ts       plugins: [bunderstack(), viteReact()]
```

```ts
// vite.config.ts
import viteReact from '@vitejs/plugin-react'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [bunderstack(), viteReact()] })
```

```ts
// src/api.ts — not src/client.ts, which is a reserved Start entry point
import { bunderstackStart } from 'bunderstack/start'

import type { App } from './bunderstack'

export const { createQueryClient, createApi } = bunderstackStart<App>()
export const queryClient = createQueryClient()
export const api = createApi(queryClient)
```

Import `App` as a type so the browser does not load server runtime code. The
same `api` works everywhere: in the browser it calls `/api` over HTTP; in SSR,
loaders, and server functions it calls the backend in the same isolate and
forwards the request's cookie, so access rules apply the same way. Do not add a
`/api/$` route, a `src/worker.ts`, or Durable Object exports.

Add `@cloudflare/vite-plugin` and `wrangler` as dev dependencies. The dev and
build scripts are `bunderstack dev` and `bunderstack build`.

## Render modes

`bunderstack.blueprint.yaml` records `application.worker.render`:

- `ssr` (the default for a TanStack Start app): pages render on the server in
  the Worker; `main` is `bunderstack/start/server-entry`.
- `spa` (the default without `@tanstack/react-start`): the Worker serves the
  API and the static client with an SPA fallback; `main` is
  `bunderstack/workers/entry`.

Change the mode by editing `render` in the blueprint; `bunderstack dev` keeps
the value. Both modes build to `dist/server/index.js` and `dist/client`.

A custom entry is an escape hatch for extra Durable Objects, queues, or
routing. Create `src/server.ts`; the generator then writes
`main: src/server.ts`:

```ts
import { createStartWorker } from 'bunderstack/start/worker'

import { backend } from './bunderstack'

const worker = createStartWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

## Runtime constraints

- Web APIs plus `nodejs_compat` only: no `Bun.*`, no local disk, no raw TCP
  (SMTP, Postgres). Use HTTP providers for email; the database is libsql.
- Files live in a bucket (R2), not on disk.
- Long or retryable work goes to jobs (`jobs: (j) => j.define(...)`); cron
  schedules come from `j.cron()`. The platform runs them in the Scheduler
  Durable Object; there is no worker process and no `runWorker()`. Queue
  handlers are at-least-once, so make them idempotent.
- Realtime fans out through the RealtimeHub Durable Object; no Redis.

## Realtime and synced collections

Clients consume the typed `realtime.changes` async iterator. Idle HTTP streams
receive a transport-only `heartbeat` every five seconds; the Bunderstack query
client filters it before cache callbacks and does not advance the Publisher
resume ID. Do not add an application polling loop or publish heartbeat events
through oRPC Publisher.

`bunderstack/sync` reconciles successful mutations from the canonical row
returned by generated CRUD, without a follow-up list refetch. Realtime echoes
are idempotent, and reconnect performs the full refetch used to repair drift.
Keep custom replacement procedures compatible by returning the complete row,
including `id`.
