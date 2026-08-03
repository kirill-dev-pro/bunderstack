---
name: creating-bunderstack-apps
description: Use when starting or structuring a Bunderstack application, choosing its runtime integration, or preparing a Bunderstack SaaS for production.
---

# Creating Bunderstack Apps

## Workflow

1. Inspect the product brief and target runtime.
2. Choose the layout from the table below.
3. For a full TanStack Start SaaS, copy `templates/tanstack-start-saas/`.
4. Configure schema, access, auth, env, storage, jobs, realtime, and tRPC.
5. Mount the single `app.handler` integration.
6. Add committed migrations and a deployment blueprint before production.
7. Run the verification contract.

| Condition | Layout |
| --- | --- |
| Small API with short configuration | `src/bunderstack.ts` |
| Auth, access, jobs, env, or tRPC need independent modules | `src/bunderstack/` |
| Full SaaS | Copy `templates/tanstack-start-saas/` and keep its modular layout |

Read [application structure](references/application-structure.md) before placing
the Bunderstack entry, schemas, authorization, or configuration modules.
Read [runtime integrations](references/runtime-integrations.md) before mounting
HTTP, adding a worker, or choosing a framework adapter. Read the
[verification contract](references/verification.md) after adding the app
scripts and again before handoff or deployment.
