# Creating Bunderstack apps: forward evidence

Date: 2026-08-03

Each scored run below used a newly spawned agent with `fork_turns: "none"`.
The exact dispatch message is preserved before the complete response, so the
context boundary, explicit `$creating-bunderstack-apps` invocation, absence of
baseline hints, and score can be audited together. The seven criteria are
layout, HTTP handler, API-process ownership, worker model, direct-write
realtime publish, provisioning, and SaaS template. Out-of-scope criteria are
N/A.

## Run 1: Full SaaS

### Exact dispatch message

```text
Work only in /Users/kirill/pet-projects/bunderstack/.worktrees/bunderstack-saas-template-skills. In a fresh context, use the repository skill `$creating-bunderstack-apps` for this task: Start a production-ready Bunderstack SaaS on TanStack Start with auth, projects, tasks, jobs, realtime, storage, email, and deployment scripts.

Return only your proposed application structure and implementation plan. Do not edit files or inspect prior task evidence.
```

Dispatch parameters: `task_name: forward_full_saas`, `fork_turns: none`.

### Verbatim response

````markdown
## Proposed application structure

Copy `templates/tanstack-start-saas/`, then organize the SaaS as:

```text
src/
  routes/
    __root.tsx
    index.tsx
    login.tsx
    dashboard/
      index.tsx
      projects/
        index.tsx
        $projectId.tsx
    api/
      $.ts                         # createApiHandlers(app)
  components/
    projects/
    tasks/
  api.ts                            # bunderstackStart<App>() client setup
  bunderstack/
    index.ts                        # declarative createBunderstack + provision
    schema/
      index.ts                      # aggregates every table, incl. bunderstack/schema
      projects.ts
      tasks.ts
    access.ts                       # explicit tenant/owner CRUD policies
    auth.ts                         # Better Auth + organization support
    env.ts                          # validated server/public environment
    storage.ts                      # private project attachment storage
    email.ts                        # transactional mail provider configuration
    realtime.ts                     # shared Redis transport in production
    jobs/
      index.ts                      # job declarations, validation, retries
      task-reminders.ts
      project-digest.ts
    trpc/
      index.ts
      projects.ts                   # related-row and role-aware operations
      tasks.ts
  worker.ts                          # await app.runWorker()
drizzle.config.ts
migrations/                         # committed generated migrations
scripts/
  deploy-web.sh
  deploy-worker.sh
  release.sh
tests/
  access.test.ts
  api.test.ts
  jobs.test.ts
  realtime.test.ts
bunderstack.blueprint.yaml
.env.example
```

## Implementation plan

1. Bootstrap from the TanStack Start SaaS template; configure `package.json#bunderstack.entry` for `src/bunderstack/index.ts`.
2. Define tenant-aware `projects` and `tasks` tables, including project membership/roles, task assignee/status/due date, and attachment metadata. Aggregate them with Better Auth and `bunderstack/schema` tables.
3. Configure Better Auth with organization-based tenancy. All dashboard routes require a session; active organization becomes the tenant boundary.
4. Implement explicit `defineAccess` policies. Scope generated CRUD by `organizationId`; use protected tRPC procedures for membership checks, role changes, cross-project task moves, and signed upload/download actions.
5. Configure validated environment values: database/auth secrets, Redis, storage provider, email provider, allowed origins, and browser-safe `PUBLIC_` API/auth values. Commit only safe placeholders in `.env.example`.
6. Add storage for private attachments, transactional email for invitations/reminders, and idempotent queue jobs with schemas, retries, and a separate `worker.ts`.
7. Enable realtime task/project subscriptions. Generated CRUD publishes automatically; direct database writes return the full row and publish only after commit. Use shared Redis transport for production web and worker processes.
8. Mount Bunderstack once through `createApiHandlers(app)` at `/api/$`; keep the browser client in `src/api.ts`.
9. Create the TanStack Start project/task UI: organization switcher, project list/detail, task board/list, task editing, realtime updates, and attachment controls.
10. Generate and commit Drizzle migrations and `bunderstack.blueprint.yaml`. Add deployment scripts for separate web and worker processes, migration/blueprint checks, health checks, and environment injection.
11. Verify from the application root:

```sh
bun install
bun test
bun run typecheck
bun run build
bun run blueprint
bun run blueprint:check
```

No files were inspected beyond the requested skill instructions, and no files were changed.
````

### Score

| Decision              | Score | Verbatim basis                                                              |
| --------------------- | ----- | --------------------------------------------------------------------------- |
| Layout                | Pass  | “Copy `templates/tanstack-start-saas/`” and `src/bunderstack/`.             |
| HTTP handler          | Pass  | “Mount Bunderstack once through `createApiHandlers(app)` at `/api/$`.”      |
| API process ownership | Pass  | TanStack Start route tree contains the sole API mount.                      |
| Worker model          | Pass  | `worker.ts # await app.runWorker()` and “separate `worker.ts`.”             |
| Direct-write realtime | Pass  | “direct database writes return the full row and publish only after commit.” |
| Provisioning          | Pass  | `index.ts # declarative createBunderstack + provision`.                     |
| Template path         | Pass  | Exact `templates/tanstack-start-saas/` path.                                |

Result: **7/7 applicable decisions correct.**

## Run 2: Tiny Bun JSON API

### Exact dispatch message

```text
Work only in /Users/kirill/pet-projects/bunderstack/.worktrees/bunderstack-saas-template-skills. In a fresh context, use the repository skill `$creating-bunderstack-apps` for this task: Add Bunderstack to a tiny Bun JSON API. Keep the setup proportionate to the project and show how HTTP traffic reaches Bunderstack.

Return only your proposed application structure and implementation plan. Do not edit files or inspect prior task evidence.
```

Dispatch parameters: `task_name: forward_tiny_api`, `fork_turns: none`.

### Verbatim response

````markdown
## Proposed application structure

```text
src/
  bunderstack.ts   # Declarative app setup: schema, access, config, exports `app`
  server.ts        # Bun process entry; mounts Bunderstack exactly once
  bunderstack.test.ts
.env.example
package.json
```

Keep the tiny API in `src/bunderstack.ts`; do not introduce a `src/bunderstack/` module tree unless it gains independent auth, access, jobs, or environment configuration.

HTTP flow:

```text
Client → Bun.serve({ fetch: app.handler }) → Bunderstack app.handler
       → routing/auth/access/database → JSON Response
```

## Implementation plan

1. Define the small domain schema and explicitly aggregate it with Bunderstack’s internal schema exports in `src/bunderstack.ts`.
2. Create one `createBunderstack()` instance, export it as `app` (and `type App = typeof app`), and keep its import graph declarative.
3. Define explicit access policies for every generated CRUD operation; keep internal/auth tables unexposed by default.
4. Add `src/server.ts`:

   ```ts
   import { app } from './bunderstack'

   Bun.serve({ fetch: app.handler })
   ```

   This is the sole HTTP mount—no parallel router, database client, or auth handler.

5. Add minimal environment documentation in `.env.example`, using runtime-owned secrets and validated configuration rather than hard-coded credentials.
6. Add a Bun test that sends a Web-Standard `Request` through `app.handler` (and/or starts the Bun server) to verify JSON responses and access behavior.
7. Add Bun scripts for development, production start, and `bun test`; only add migrations/provisioning artifacts if the API persists data.
````

### Score

| Decision              | Score | Verbatim basis                                  |
| --------------------- | ----- | ----------------------------------------------- |
| Layout                | Pass  | “Keep the tiny API in `src/bunderstack.ts`.”    |
| HTTP handler          | Pass  | Exact `Bun.serve({ fetch: app.handler })` code. |
| API process ownership | Pass  | “This is the sole HTTP mount.”                  |
| Worker model          | N/A   | No jobs requested.                              |
| Direct-write realtime | N/A   | No realtime write requested.                    |
| Provisioning          | N/A   | Conditional only if the API persists data.      |
| Template path         | N/A   | Not a full SaaS.                                |

Result: **3/3 applicable decisions correct.**

## Run 3: React SPA initial forward result

### Exact dispatch message

```text
Work only in /Users/kirill/pet-projects/bunderstack/.worktrees/bunderstack-saas-template-skills. In a fresh context, use the repository skill `$creating-bunderstack-apps` for this task: Build a React SPA backed by Bunderstack. Explain which process owns the API and how the frontend reaches it.

Return only your proposed application structure and implementation plan. Do not edit files or inspect prior task evidence.
```

Dispatch parameters: `task_name: forward_react_spa`, `fork_turns: none`.

### Verbatim response

````markdown
## Proposed application structure

```text
my-app/
  src/
    server.ts                 # Bun process; creates Bunderstack and owns API
    app.ts                    # Bunderstack configuration and raw instance exports
    routes/
      api/
        todos.ts              # Hono/Bunderstack API routes under /api
    db/
      schema.ts               # Drizzle schema
      index.ts                # libSQL/Drizzle connection
    frontend/
      index.html              # SPA document
      main.tsx                # React entry point
      App.tsx                 # Route/layout shell
      pages/
      components/
      lib/
        api.ts                # typed fetch client using relative /api URLs
  public/                     # static assets
  drizzle.config.ts
  package.json
```

## Implementation plan

1. Build a single Bun server process in `src/server.ts` that instantiates Bunderstack and serves `app.handler`.
2. Register Bunderstack/Hono API routes beneath `/api`, with database/auth/storage dependencies configured in `src/app.ts`.
3. Build the React SPA from `src/frontend/index.html` and `main.tsx` using Bun’s HTML import and bundling support.
4. Have the server return the SPA document/assets for non-`/api` browser routes, enabling client-side React routing.
5. Keep frontend API calls in `frontend/lib/api.ts` and use relative paths such as `fetch("/api/todos")`.
6. During development, run the Bun/Bunderstack server as the API-owning process; the frontend reaches it on the same origin through `/api`, so no separate API host or CORS configuration is required.
````

### Score

| Decision              | Score | Verbatim basis                                                                                     |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| Layout                | Fail  | `src/app.ts` plus nested `src/frontend/` in one app.                                               |
| HTTP handler          | Pass  | “serves `app.handler`” selects the Web Standard handler even though the process boundary is wrong. |
| API process ownership | Fail  | “Build a single Bun server process” and “no separate API host.”                                    |
| Worker model          | N/A   | No jobs requested.                                                                                 |
| Direct-write realtime | N/A   | No realtime write requested.                                                                       |
| Provisioning          | N/A   | Production persistence was not required.                                                           |
| Template path         | N/A   | Not a full SaaS.                                                                                   |

Observed gap: **1/3 applicable decisions correct.** The verbatim transcript
corrects the earlier paraphrase-only score: handler selection was right, while
layout and API-process ownership were wrong.

## Refactor triggered by Run 3

The wrong-shaped result led to the positive **Runtime decision recipe** in
`SKILL.md`. Its React-SPA branch specifies an `api/` project containing the
Bunderstack entry and Bun API process, an independent `frontend/` React build,
API ownership of `app.handler`, and a configured browser API base URL. It
supplies the target shape instead of banning same-origin SPA hosting.

## Run 4: React SPA fresh re-test

### Exact dispatch message

```text
Work only in /Users/kirill/pet-projects/bunderstack/.worktrees/bunderstack-saas-template-skills. In a fresh context, use the repository skill `$creating-bunderstack-apps` for this task: Build a React SPA backed by Bunderstack. Explain which process owns the API and how the frontend reaches it.

Return only your proposed application structure and implementation plan. Do not edit files or inspect prior task evidence.
```

Dispatch parameters: `task_name: forward_react_spa_controlled`,
`fork_turns: none`. This message is byte-for-byte identical to Run 3's
dispatch message; only the skill revision differs.

### Verbatim response

````markdown
## Proposed application structure

```text
/
├── package.json                    # Bun workspace scripts for dev, test, build, blueprint
├── bun.lock
├── .env.example
├── bunderstack.blueprint.yaml
├── migrations/
├── api/
│   ├── package.json
│   └── src/
│       ├── index.ts                # Bun.serve({ fetch: app.handler })
│       └── bunderstack/
│           ├── index.ts            # Constructs and exports the single app and App type
│           ├── schema/
│           │   ├── index.ts        # Aggregates domain, auth, and bunderstack/schema tables
│           │   └── items.ts
│           ├── access.ts           # Explicit server-side CRUD and tenant policies
│           ├── auth.ts
│           ├── env.ts              # Validated server configuration
│           ├── trpc/
│           │   └── index.ts
│           └── jobs/
│               └── index.ts
└── frontend/
    ├── package.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts                  # Browser client configured with PUBLIC_API_BASE_URL
        ├── routes/
        ├── components/
        └── styles.css
```

The Bun process in `api/src/index.ts` owns the API and mounts the single Bunderstack `app.handler`. The React SPA has no server handler and never constructs a Bunderstack app, database, or auth instance. Its browser client reads `PUBLIC_API_BASE_URL` at build/runtime and sends HTTP, auth, tRPC, CRUD, and SSE requests to that Bun API origin. Local development can use separate ports, with API CORS configured for the frontend origin; production can expose both behind one domain or use an explicit API subdomain.

## Implementation plan

1. Create a Bun workspace containing independent `api` and `frontend` packages, with root scripts that run both development processes and aggregate verification.
2. Define the complete Drizzle schema in `api/src/bunderstack/schema/`, including required Better Auth tables and `bunderstack/schema` exports.
3. Add validated server environment variables, auth configuration, explicit access rules, tenant scopes, optional tRPC procedures, jobs, storage, and realtime configuration.
4. Assemble exactly one `createBunderstack()` instance in `api/src/bunderstack/index.ts`; export `app` and `type App = typeof app`, and call `provision(app)` if this application owns provisioning.
5. Start the API with `Bun.serve({ fetch: app.handler })`. Keep background workers in a separate entry/process if jobs are enabled.
6. Build the React SPA with Bun HTML imports and configure its typed client in `frontend/src/api.ts` using `PUBLIC_API_BASE_URL`; import `App` as a type only.
7. Implement authentication state, protected routes, domain screens, loading/error handling, and SSE lifecycle handling. Treat server access policies—not hidden UI—as authorization.
8. Add `.env.example` entries for the API origin, browser origin, database, auth, storage, and shared realtime transport without committing secrets.
9. Generate and commit Drizzle migrations plus `bunderstack.blueprint.yaml`; configure `package.json#bunderstack.entry` for the modular API entry.
10. Verify from the application root with `bun install`, `bun test`, `bun run typecheck`, `bun run build`, `bun run blueprint`, and `bun run blueprint:check`.
````

### Score

| Decision              | Score | Verbatim basis                                        |
| --------------------- | ----- | ----------------------------------------------------- |
| Layout                | Pass  | “independent `api` and `frontend` packages.”          |
| HTTP handler          | Pass  | Exact `Bun.serve({ fetch: app.handler })`.            |
| API process ownership | Pass  | “The Bun process in `api/src/index.ts` owns the API.” |
| Worker model          | N/A   | No jobs requested.                                    |
| Direct-write realtime | N/A   | No realtime write requested.                          |
| Provisioning          | N/A   | Production persistence was not required.              |
| Template path         | N/A   | Not a full SaaS.                                      |

Controlled result after refactor: **3/3 applicable decisions correct.** Because
the dispatch is identical to Run 3, the refactor still passes without the
extra reference-loading instruction used by the superseded re-test.

## Conclusion

The preserved dispatches show that no baseline failures or desired answers
were supplied. Runs 1 and 2 selected the intended contracts immediately. Run 3
exposed the React SPA decision-shape gap, and controlled Run 4 independently
verifies the positive runtime recipe that closed it.
