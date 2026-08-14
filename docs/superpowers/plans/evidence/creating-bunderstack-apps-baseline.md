# Creating Bunderstack apps: no-skill baseline

Date: 2026-08-03

These three prompts were run in isolated, fresh agent contexts while the
repository did not contain `.agents/skills/creating-bunderstack-apps/`. The
agents were given only the prompt below and were not permitted to inspect the
repository or its skills.

## Full SaaS scenario

Prompt:

> Start a production-ready Bunderstack SaaS on TanStack Start with auth,
> projects, tasks, jobs, realtime, storage, email, and deployment scripts.

Response:

> I’ll scaffold it as a Bun-first monorepo with a TanStack Start web app and
> Bunderstack API.
>
> 1. Define tenancy, roles, project/task/job data model, and API contracts.
> 2. Set up TanStack Start with authenticated routes, dashboard shell, and
>    typed API client.
> 3. Configure BetterAuth with email/password, sessions, protected endpoints,
>    and organization membership.
> 4. Add Drizzle/libSQL schema and migrations for users, organizations,
>    projects, tasks, jobs, and audit events.
> 5. Build project/task CRUD, job queue endpoints and workers, plus SSE
>    realtime updates.
> 6. Add object storage uploads with signed URLs and metadata persistence.
> 7. Implement transactional email templates and delivery adapter.
> 8. Add validation, error handling, rate limiting, observability, tests,
>    environment templates, Docker/deployment scripts, and CI.
>
> Before implementation, I’d confirm the deployment target (e.g. Fly.io,
> Railway, Docker/VPS) and preferred email/storage providers.

| Contract decision                                              | Result                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Modular `src/bunderstack/` layout                              | Not selected; only an unrelated monorepo layout was proposed.                |
| TanStack Start `createApiHandlers(app)` handler mount          | Not specified.                                                               |
| Separate `src/worker.ts` calling `app.runWorker()`             | Not specified; “job queue endpoints and workers” leaves ownership ambiguous. |
| Typed `publish(table, event, completeRow)` after direct writes | Not specified; proposed SSE instead.                                         |
| `provision(app)`                                               | Not specified.                                                               |
| `templates/tanstack-start-saas/` starting point                | Not specified.                                                               |

## Tiny Bun JSON API scenario

Prompt:

> Add Bunderstack to a tiny Bun JSON API. Keep the setup proportionate to the
> project and show how HTTP traffic reaches Bunderstack.

Response:

> I’ll first inspect the tiny API’s current entry point and dependencies, then
> add the smallest Bunderstack setup that preserves the existing JSON route.
> I’ll wire Bun’s server so incoming requests flow through Bunderstack’s
> `app.handler`, document that request path inline, and verify it with the
> project’s Bun test or a local HTTP request.

| Contract decision                                 | Result                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| Single `src/bunderstack.ts` layout                | Not stated, though “smallest setup” is directionally proportionate. |
| Web Standard `Request -> app.handler -> Response` | Correctly selected.                                                 |
| Dedicated worker                                  | Not applicable to this prompt and not added.                        |
| Typed realtime publish                            | Not applicable to this prompt and not stated.                       |
| `provision(app)`                                  | Not specified.                                                      |
| Full SaaS template path                           | Not applicable to this prompt and not stated.                       |

## React SPA scenario

Prompt:

> Build a React SPA backed by Bunderstack. Explain which process owns the API
> and how the frontend reaches it.

Response:

> I’ll build it as two processes:
>
> - **Bunderstack/Bun** owns the API: it runs the backend server and exposes
>   routes such as `/api/*`.
> - **React** owns the browser UI: in development, its dev server proxies
>   `/api` requests to Bunderstack; in production, serve the built SPA from
>   Bunderstack so both share one origin.
>
> Plan:
>
> 1. Create a Bunderstack app with a small example API route.
> 2. Create a React SPA with a page that fetches data from `/api`.
> 3. Configure the React development server proxy to the Bunderstack port.
> 4. Add scripts to run the API and frontend together, plus production
>    build/serving instructions.

| Contract decision                | Result                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| Proportionate Bunderstack layout | Not specified.                                                         |
| API process owns `app.handler`   | API process ownership is correct; handler forwarding is not specified. |
| Dedicated worker                 | Not specified.                                                         |
| Typed realtime publish           | Not specified.                                                         |
| `provision(app)`                 | Not specified.                                                         |
| Full SaaS template path          | Not specified.                                                         |

## Baseline conclusion

Without repository guidance, the scenarios produced generic, partly compatible
plans but not the precise Bunderstack application contract. The new contract
test is intentionally RED until a discoverable repository skill provides the
missing guidance.
