# Bunderstack app skill and SaaS template design

Date: 2026-08-03
Status: approved

## Goal

Create a repository-owned skill that teaches agents how to start Bunderstack
applications correctly, plus a separately maintained, runnable TanStack Start
SaaS template. Also move the existing migration skill into the repository and
bring its guidance up to date with the current Bunderstack runtime contract.

## Deliverables

1. `.agents/skills/creating-bunderstack-apps/`
   - Guidance only; no embedded copy of the application template.
   - Explain when to keep configuration in `src/bunderstack.ts` and when to
     use a modular `src/bunderstack/` directory.
   - Treat TanStack Start as the canonical integration.
   - Explain the Web Standard `Request -> app.handler -> Response` contract
     for Astro, a React SPA with a separate API server, and other runtimes.
   - Point agents to `templates/tanstack-start-saas/` as the preferred starting
     point for a full application.

2. `templates/tanstack-start-saas/`
   - A standalone Bun and TanStack Start application using Tailwind CSS and
     shadcn/ui conventions.
   - Demonstrate a `projects` and `tasks` domain.
   - Include email/password auth, `user` and `admin` roles, owner-scoped CRUD,
     realtime, storage, jobs, cron, email, typed env, a public landing page,
     auth pages, a user dashboard, and an admin dashboard.

3. `.agents/skills/migrating-to-bunderstack/`
   - Start from the existing Gemini migration skill.
   - Correct outdated realtime, worker, API-handler, provisioning, schema, and
     deployment guidance.
   - Keep it focused on migration; refer to the template only as a picture of
     the desired end state.

## Skill and template boundary

The skills describe decisions and workflows. They do not hide or duplicate
application source code. The full scaffold is an ordinary project under
`templates/`, versioned and tested with the library. The creating skill tells
agents to copy that directory when a full SaaS starting point is appropriate,
then adapt the product domain and visual design.

Small API projects may use a single `src/bunderstack.ts`. When auth, access,
env, jobs, or tRPC configuration becomes independently meaningful, use:

```text
src/bunderstack/
  index.ts
  access.ts
  auth.ts
  env.ts
  schema/
  jobs/
  trpc/
```

The full SaaS template always uses the modular layout.

## Runtime contract

TanStack Start owns the web process. Its `/api/$` catch-all route uses
`createApiHandlers(app)` from `bunderstack-start`, which forwards requests to
the single Web Standard `app.handler` integration point. Client setup uses
`bunderstackStart<App>()` so table, bucket, tRPC, and sync types come from the
server app type without bundling server runtime code into the browser.

The Bunderstack entry constructs and exports `app`, calls `provision(app)`, and
does not start an embedded production worker. `src/worker.ts` owns
`app.runWorker()`. Multi-process or multi-instance deployments use a shared
Redis realtime transport. Cron tasks use `jobs.cron()` and platform delivery,
not application-specific HTTP cron routes.

`package.json#bunderstack.entry` points to `src/bunderstack/index.ts`. The
template supplies blueprint generation and check scripts. App declaration
imports must avoid unrelated external side effects so introspection remains
safe.

## Data and authorization

Projects belong to users. Tasks belong to projects. CRUD list access is
constrained with read scopes, while row changes use owner rules or protected
tRPC procedures when authorization depends on a related project. Internal and
administrative tables are not exposed through generated CRUD.

The admin dashboard reads through protected tRPC procedures that verify the
role on the server. UI route visibility is only presentation and is never an
authorization boundary.

Generated CRUD publishes realtime changes automatically. Direct Drizzle writes
publish only after the write succeeds, using the typed
`publish(table, event, completeRow)` facade. The complete returned row is used
so access filtering has all required fields.

## Development and production defaults

Development uses a local libSQL database, local file storage, and console
email. `.env.example` contains variable names and safe placeholders only.
Production credentials remain environment-owned.

`provision(app)` supports the development push loop until a migrations folder
is committed, then applies those committed migrations. Drizzle scripts remain
available for generating migrations. The template declares its environment
requirements through Bunderstack env configuration so they appear in the
deployment blueprint.

## Error handling

Invalid server configuration fails during startup. Authentication and
authorization failures use the framework's normal HTTP responses. UI-facing
calls normalize errors into actionable messages without exposing server stack
traces or secrets. Jobs declare validation, retries, and failure behavior.

## Verification

The template includes:

- structural contract tests for the Bunderstack entry, package scripts, worker,
  and API mount;
- in-memory handler integration tests;
- ownership and admin authorization tests;
- job and realtime behavior tests;
- typecheck, production build, and blueprint checks.

Each skill is developed and forward-tested separately. The creating skill is
completed first. The migration skill is then copied, updated, and independently
validated so one skill's test context does not mask gaps in the other.
