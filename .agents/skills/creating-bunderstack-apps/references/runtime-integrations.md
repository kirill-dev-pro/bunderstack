# Runtime integrations

`app.handler` is the single Web Standard `Request -> Response` integration
point. Mount it once; do not recreate routing, auth, or database layers in a
framework adapter.

## TanStack Start

TanStack Start owns the web process. Use `bunderstackStart<App>()` for the
client and mount the catch-all route with `createApiHandlers(app)`:

```ts
export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})
```

Keep the client setup in `src/api.ts`, not `src/client.ts`, which is a reserved
Start entry point. Import `App` as a type so the browser does not load server
runtime code.

## Standalone Bun and other runtimes

For a standalone server, pass the handler directly:

```ts
Bun.serve({ fetch: app.handler })
```

Other server frameworks must adapt their request and response objects to the
Web Standard pair, then delegate to `app.handler`. Astro adapters therefore
convert to and from Web Standard requests and responses. A browser-only React
SPA has no server request handler: run a separate Bun API process and point the
frontend's API base URL at that process.

## Background runtime

Declare queue jobs with `jobs: (j) => j.define(...)`, then run them in a
separate production process:

```ts
import { app } from './bunderstack'

await app.runWorker()
```

Do not start a production worker or cron scheduler from the web entry.
`j.cron()` is delivered by the platform over authenticated HTTP. Queue handlers
are at-least-once, so make them idempotent and declare input validation and
retries.

If workers publish realtime events, configure the same shared Redis transport
for web and worker processes. `realtime: true` alone is process-local and is
only safe when the worker is embedded with `app.startWorker()` for local work.
