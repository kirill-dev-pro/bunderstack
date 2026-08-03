# Creating Bunderstack apps: forward evidence

Date: 2026-08-03

Each scenario was run by a fresh agent with an explicit
`$creating-bunderstack-apps` invocation. The dispatch prompt named only the
scenario and repository skill; it did not disclose baseline evidence,
suspected failure, or expected solution. The seven scores are layout, HTTP
handler, API-process ownership, worker model, direct-write realtime publish,
provisioning, and SaaS template. Out-of-scope criteria are N/A.

## Full SaaS scenario

Prompt:

> Use `$creating-bunderstack-apps` to start a production-ready Bunderstack SaaS
> on TanStack Start with auth, projects, tasks, jobs, realtime, storage, email,
> and deployment scripts.

The response selected `templates/tanstack-start-saas/`, retained modular
`src/bunderstack/`, mounted `createApiHandlers(app)` at `/api/$`, and put
`await app.runWorker()` in `src/worker.ts`. It described `provision(app)`,
committed migrations and a blueprint, plus complete-row, post-commit typed
realtime publishing over a shared production Redis transport.

| Decision | Score | Evidence |
| --- | --- | --- |
| Layout | Pass | Versioned SaaS template and modular entry. |
| HTTP handler | Pass | `createApiHandlers(app)` at `/api/$`. |
| API process ownership | Pass | TanStack Start owns the web/API mount. |
| Worker model | Pass | Separate `src/worker.ts` calls `app.runWorker()`. |
| Direct-write realtime | Pass | Complete returned row publishes after commit. |
| Provisioning | Pass | Declarative entry includes `provision(app)`. |
| Template path | Pass | `templates/tanstack-start-saas/` copied first. |

Result: **7/7 applicable decisions correct.**

## Tiny Bun JSON API scenario

Prompt:

> Use `$creating-bunderstack-apps` to add Bunderstack to a tiny Bun JSON API.
> Keep the setup proportionate to the project and show how HTTP traffic reaches
> Bunderstack.

The response chose `src/bunderstack.ts` with `src/server.ts`, exported one
`app`, and showed this traffic path:

```text
Client -> Bun.serve({ fetch: app.handler }) -> Bunderstack app.handler
       -> routing/auth/access/database -> JSON Response
```

| Decision | Score | Evidence |
| --- | --- | --- |
| Layout | Pass | Single `src/bunderstack.ts` selected. |
| HTTP handler | Pass | Bun delegates directly to `app.handler`. |
| API process ownership | Pass | `src/server.ts` is the sole Bun mount. |
| Worker model | N/A | No jobs requested. |
| Direct-write realtime | N/A | No realtime write requested. |
| Provisioning | N/A | Persistence was not required. |
| Template path | N/A | Not a full SaaS. |

Result: **3/3 applicable decisions correct.**

## React SPA scenario and refactor

Prompt:

> Use `$creating-bunderstack-apps` to build a React SPA backed by Bunderstack.
> Explain which process owns the API and how the frontend reaches it.

### Initial forward result

The initial response put SPA and API in one Bun process and used same-origin
relative `/api` calls. It missed the intended browser-only SPA boundary and
used `src/app.ts` instead of the selected Bunderstack entry layout.

| Decision | Score | Evidence |
| --- | --- | --- |
| Layout | Fail | Single-process `src/app.ts` layout. |
| HTTP handler | Fail | Handler only described as a `/api/*` SPA-server branch. |
| API process ownership | Fail | SPA host and API collapsed into one process. |
| Worker model | N/A | No jobs requested. |
| Direct-write realtime | N/A | No realtime write requested. |
| Provisioning | N/A | Production persistence was not required. |
| Template path | N/A | Not a full SaaS. |

Observed gap: **0/3 applicable decisions correct.**

### Refactor

`SKILL.md` now has a positive **Runtime decision recipe**. Its React-SPA branch
specifies an `api/` project containing the Bunderstack entry and Bun API
process, an independent `frontend/` React build, API ownership of
`app.handler`, and a configured browser API base URL. It supplies the target
shape instead of banning same-origin SPA hosting.

### Fresh re-test

The final response produced separate `api/` and `frontend/` projects with
`Bun.serve({ fetch: app.handler })`, and showed:

```text
fetch(`${PUBLIC_API_BASE_URL}/...`) -> api/src/server.ts -> app.handler
```

| Decision | Score | Evidence |
| --- | --- | --- |
| Layout | Pass | Separate API and browser-only frontend projects. |
| HTTP handler | Pass | `Bun.serve({ fetch: app.handler })`. |
| API process ownership | Pass | Separate API process exclusively owns `app.handler`. |
| Worker model | N/A | No jobs requested. |
| Direct-write realtime | N/A | No realtime write requested. |
| Provisioning | N/A | Production persistence was not required. |
| Template path | N/A | Not a full SaaS. |

Result after refactor: **3/3 applicable decisions correct.**

## Conclusion

The full SaaS and tiny API scenarios selected the intended contracts on their
first forward run. One React SPA decision-shape gap was observed, refactored
with a positive conditional recipe, and verified in a fresh-context re-test.
