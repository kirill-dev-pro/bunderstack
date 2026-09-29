# SSR by default on the Workers runtime

Date: 2026-09-29
Branch: `next` (bunderstack), `codex/celld-vps-deployment` (bunderhost)
Release: `bunderstack@1.0.0-beta.4`
Depends on: `2026-09-29-blueprint-source-of-truth-design.md` (beta.3)

## Context

Bunderstack 1.0 moved apps to the Workers runtime and made the frontend an SPA.
SSR was a non-goal of the Workers runtime spec, not a platform limit. A spike on
2026-09-29 ran TanStack Start with SSR in the same Worker as `createWorker`:

- On celld 0.6 and on workerd (`wrangler dev`): SSR streaming, the user from the
  auth cookie in SSR, loaders and server functions calling the backend in the
  same isolate, hydration, client-side server functions (`/_serverFn/...`), and
  realtime after hydration all work. Isolate cold start on celld is about 68 ms.
  The server bundle is 6 MB, 1.2 MB gzip.
- In `vite dev` with `@cloudflare/vite-plugin`: SSR, the backend, auth, and
  Durable Objects (the realtime hub) run in workerd with HMR.
- The Cloudflare Vite plugin builds `dist/server/index.js` (ESM with chunks) and
  `dist/client`. celld runs that artifact after `dist/client/.assetsignore` is
  removed. The plugin also copies `.dev.vars` to `dist/server/`.
- Found constraints: the server build must target Workers (the Cloudflare plugin
  does this; a plain Vite 8 build injects `node:module.createRequire`, which
  celld lacks). The Start server entry must be the Worker, so the backend has one
  module graph; a separate `worker.ts` importing a Start bundle loads the backend
  twice.

## Product decisions

- SSR is the default for new apps and for the upcoming template. SPA stays as an
  explicit mode.
- SSR supports TanStack Start with React only in this release.
- `bunderstack dev` runs the app in workerd through the Cloudflare Vite plugin.
  celld no longer runs in dev. celld compatibility is the job of
  `bun run test:workers`.
- Server code reaches the backend through the same typed client as the browser.
  On the server the call stays in the isolate and forwards the incoming cookie.
  Access rules apply the same way everywhere.
- The developer does not write Worker code. An app has `src/bunderstack.ts`, an
  API client, routes, and `vite.config.ts` with the `bunderstack()` plugin. There
  is no `src/server.ts`, no `src/worker.ts`, no `/api/$` route, and no Durable
  Object exports. A custom `src/server.ts` is an optional escape hatch.
- No separate preview command. `bunderstack build` produces the artifact that
  hosts deploy.

## Developer surface

```
src/bunderstack.ts   backend: schema, auth, access, storage, jobs, cron
src/api.ts           createClient<App>({ queryClient, fetch: startFetch })
src/routes/...       Start routes, loaders, server functions
vite.config.ts       plugins: [bunderstack(), viteReact()]
```

`bunderstack()` from `bunderstack/vite`:

- adds `cloudflare({ viteEnvironment: { name: 'ssr' } })` and `tanstackStart()`
  in the right order for `render: ssr`, and `cloudflare()` alone for
  `render: spa`;
- resolves the virtual module `virtual:bunderstack/backend` to the app's backend
  entry (`package.json#bunderstack.entry`, default `src/bunderstack.ts`);
- reads `render` from the committed blueprint.

`startFetch` from `bunderstack/start`:

- in the browser: `fetch` with `credentials: 'include'`;
- on the server (SSR, loaders, server functions): builds a request for the
  bunderstack handler of this isolate with the incoming request's cookie and
  origin, and calls it without a network hop. The Worker env comes from
  `import { env } from 'cloudflare:workers'`. The handler is the one registered
  by the server entry; `startFetch` throws a clear error if none is registered.

The existing `bunderstack/start` module (0.x isomorphic fetch, auth client) is
rewritten for this; it does not get a second sibling module.

Where the runtime still shows, as documented constraints rather than API: Web
APIs plus `nodejs_compat` only (no `Bun.*`, no local disk, no raw TCP such as
SMTP or Postgres); long work goes to jobs; files live in a bucket.

## Server entries

Two package exports replace the app's `src/worker.ts`:

- `bunderstack/start/server-entry` (SSR):
  - imports the backend from `virtual:bunderstack/backend` and creates the
    bunderstack Worker once per isolate;
  - registers it for `startFetch`;
  - `fetch`: `/api/*` to bunderstack, every other path to
    `createStartHandler(defaultStreamHandler)`;
  - `scheduled`: to the Scheduler;
  - named exports `Scheduler`, `RealtimeHub`, `RateLimiter`.
- `bunderstack/workers/entry` (SPA): the same without Start; a path without a
  route goes to `ASSETS`, as `createWorker` does today.

If `src/server.ts` exists, `bunderstack()` uses it as the entry instead, and the
generator writes `main: src/server.ts`. The file must export the three Durable
Object classes; `bunderstack/start` exports `createStartWorker(backend)` for it:

```ts
import { createStartWorker } from 'bunderstack/start'
import { backend } from './bunderstack'

const worker = createStartWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

The server entry is the only place that composes Start and bunderstack, so the
backend has one module graph.

## Contract

### Blueprint (version 2)

`application.worker` gains a required `render`:

```yaml
application:
  framework: tanstack-start
  scripts: { build: build }
  worker:
    render: ssr
    main: bunderstack/start/server-entry
    compatibilityDate: "2026-09-28"
    assets: dist/client
```

- `render: ssr | spa`, required. A beta.3 blueprint without it fails to parse
  with "regenerate the blueprint with bunderstack 1.0.0-beta.4".
- `main` is either a relative path inside the package (a custom entry) or one of
  the two package entries `bunderstack/start/server-entry` and
  `bunderstack/workers/entry`. Nothing else.
- Generator defaults for a new file: `render: ssr` when `@tanstack/react-start`
  is a dependency, else `spa`; `main`: `src/server.ts` if it exists, else the
  package entry for the render mode. Values in the committed file win, as for the
  other `worker` keys.
- `framework` keeps being detected; `tanstack-start` with `render: spa` is valid
  (a Start app in SPA mode).

### `WorkerPlan`

```ts
type WorkerPlan = {
  render: 'ssr' | 'spa'
  main: string // the source entry, for the Vite plugin and wrangler
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: { ... } // unchanged
  buckets: { ... }[] // unchanged
  crons: string[] // unchanged
  assets: {
    directory: string
    notFoundHandling: 'none' | 'single-page-application'
    runWorkerFirst: string[] // spa: /api/* and operation prefixes; ssr: []
  }
  artifact: { main: 'dist/server/index.js'; assets: string; modules: true }
}
```

`artifact` is what a host deploys after `bun run build`. Both render modes build
through the Cloudflare Vite plugin, so the artifact has one shape.

### `wrangler.json`

Still generated from the blueprint and git-ignored. It is the input config of
the Cloudflare Vite plugin: the source `main`, bindings, Durable Objects, R2,
crons, and assets routing. The plugin writes its own output config to
`dist/server/wrangler.json`; bunderstack and hosts do not read it.

## CLI

`bunderstack dev`:

1. Regenerate the blueprint, then `wrangler.json`.
2. Start sqld; push the schema or apply committed migrations; repeat on changes
   under `src/` (as today).
3. Write `.dev.vars`: database URL, `AUTH_SECRET`, and `APP_URL` equal to the
   Vite URL on `localhost` (better-auth rejects a `127.0.0.1` origin when
   `APP_URL` says `localhost`, and the reverse).
4. Run `vite dev`. SSR, `/api`, and Durable Objects run in workerd with HMR.

celld is not started. The `/api` proxy part of `bunderstack/vite` is removed.

`bunderstack build`:

1. Fail on a missing or stale blueprint.
2. Write `wrangler.json`.
3. `vite build`.
4. Delete `dist/client/.assetsignore` and every `.dev.vars` under `dist/`. The
   Cloudflare plugin copies the local `.dev.vars` into `dist/server/` on every
   build, so a local build after `bunderstack dev` always has one; hosts refuse
   an artifact that still contains it.

The pinned celld binary stays for `test:workers` only.

## Bunderhost

- `renderCelldConfig` uses `plan.artifact.main` and `plan.artifact.assets`, and
  `assets.not_found_handling` from the plan.
- The Worker builder, after `bun run build`: delete
  `dist/client/.assetsignore` if present; fail if `.dev.vars` exists anywhere
  under the release's `dist/`; check that `plan.artifact.main` exists.
- `loadWorkerPackage` checks the source `main` only when it is a relative path;
  for a package entry it checks that the name is one of the two known entries.
- A future Cloudflare renderer uploads the modules under `dist/server/` and the
  asset manifest of `dist/client`; the plan already carries both paths.

Revision loading, env preflight, and rollback do not change.

## Migration of existing Worker apps

`todo-solid-native`, `agent-chat`, and `workers-probe` delete `src/worker.ts`,
use `bunderstack()` in `vite.config.ts` (or a minimal Vite config for
`workers-probe`), and regenerate the blueprint (`render: spa`, package entry).

## Testing

Unit:

- Blueprint: `render` required; beta.3 file rejected with the beta.4 message;
  `main` accepts relative paths and the two package entries and rejects other
  specifiers.
- Generator: `ssr` with `@tanstack/react-start`, else `spa`; `src/server.ts`
  wins when present; committed values are kept.
- `WorkerPlan`: `notFoundHandling` and `runWorkerFirst` per mode; `artifact`.
- `startFetch`: server path calls the registered handler in the isolate and
  forwards cookie and origin; client path sets `credentials`; a clear error when
  no handler is registered.
- Server entries: `/api/*` to bunderstack, other paths to Start (SSR) or
  `ASSETS` (SPA), `scheduled` to the Scheduler, the three named exports.
- `bunderstack build`: removes `.assetsignore` and `dist/**/.dev.vars`.

Integration (`bun run test:workers`, celld and workerd, on the built artifact):

- The 8 existing scenarios on `workers-probe`, now built through the plugin.
- A new example `examples/ssr-probe` (TanStack Start, `render: ssr`): SSR shows
  the signed-in user; a loader reads through `api`; a client-side server
  function returns data; a write reaches the page through realtime after
  hydration.

Dev smoke: `bunderstack dev` on `ssr-probe` starts, `/` renders with the user,
and a schema change is pushed.

Bunderhost: builder removes `.assetsignore`, refuses `.dev.vars`, and deploys
`artifact.main`; celld config snapshot for both render modes; package-entry
`main` accepted, unknown specifier rejected.

## Order

1. Contract: `render`, `main` forms, `artifact`, `WorkerPlan`.
2. Server entries, `virtual:bunderstack/backend`, and the `bunderstack()` Vite
   plugin.
3. `bunderstack/start`: `startFetch`, `createStartWorker`.
4. CLI: `dev` on the Vite plugin, `build` artifact checks.
5. Examples move to the package entries; `ssr-probe`; `test:workers` on the
   artifact.
6. Documentation and the `creating-bunderstack-apps` skill.
7. Release beta.4, then the Bunderhost changes.

## Out of scope

- Solid Start and other SSR frameworks.
- The new full-feature template (its own spec, after this one).
- The Cloudflare Workers for Platforms renderer.
- A celld runtime option for `bunderstack dev`.

## Verified before planning

Both were open when this spec was written and were checked on 2026-09-29 with
the spike app, in `vite dev` (workerd) and on the plugin-built artifact in celld
0.6:

- `import { env } from 'cloudflare:workers'` works in both.
- A package specifier as `main` (standing in for
  `bunderstack/start/server-entry`) that imports the backend through a Vite
  virtual module resolved by a plugin builds and runs in both. The package
  entry and the app code share one module graph, so a module-level registry in
  `bunderstack/start` is enough for `startFetch`.
