---
name: creating-bunderstack-apps
description: Use when starting or structuring a Bunderstack application, choosing its runtime integration, or preparing a Bunderstack SaaS for production.
---

# Creating Bunderstack Apps

## Workflow

1. Inspect the product brief and target runtime.
2. Choose the layout from the table below.
3. For a full TanStack Start SaaS, copy `templates/tanstack-start-saas/`.
4. Configure schema, access, auth, env, storage, jobs, realtime, and the oRPC API graph.
5. Mount the single `app.handler` integration.
6. Add committed migrations and a deployment blueprint before production.
7. Run the verification contract.

| Condition                                                                   | Layout                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Small API with short configuration                                          | `src/bunderstack.ts`                                              |
| Auth, access, jobs, env, or custom oRPC procedures need independent modules | `src/bunderstack/`                                                |
| Full SaaS                                                                   | Copy `templates/tanstack-start-saas/` and keep its modular layout |

## Runtime decision recipe

Choose the process boundary before listing files. A TanStack Start SaaS keeps
the API mount in Start. A standalone Bun API has `src/bunderstack.ts` (or the
modular `src/bunderstack/` entry) and a Bun process that delegates to
`app.handler`.

For a React SPA brief, use the browser-only layout: an `api/` project contains
the Bunderstack entry and Bun API process, and a separate `frontend/` project
contains the React build. The API process owns `app.handler`; the browser
client receives a configured API base URL and calls that process. Include both
processes and the configured browser-to-API path in the proposed structure.

Read [application structure](references/application-structure.md) before placing
the Bunderstack entry, schemas, authorization, or configuration modules.
Read [runtime integrations](references/runtime-integrations.md) before mounting
HTTP, adding a worker, or choosing a framework adapter. Read the
[verification contract](references/verification.md) after adding the app
scripts and again before handoff or deployment.
