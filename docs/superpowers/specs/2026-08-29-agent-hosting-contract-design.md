# Agent-Facing Hosting Contract — Design

**Date:** 2026-08-29
**Status:** Approved for implementation
**Scope:** `packages/bunderstack` only. No hosting-specific code.

## Problem

Bunderhost is building an MCP server so an external coding agent can inspect and
operate a deployed application: read deployments and logs, create a project from
a repository, collect the secrets the app needs, run the first deploy, verify the
result, and report the live URL.

Two of those steps cannot be done today without information only the application
itself knows:

1. **Which configuration values are secret.** The blueprint lists environment
   keys with `required` and `scope`, but nothing marks a key as a secret. The
   host cannot decide which keys an agent may set directly and which must be
   typed by a human into a protected setup page.

2. **What the application actually exposes and whether it came up healthy.**
   `/api/health` returns `{ status: 'ok' }` from a handler that does no work. It
   proves the process serves HTTP; it does not prove the database is reachable,
   the schema is provisioned, or the background worker is draining its queue. The
   host also has no static catalog of the application's own API operations, so an
   agent has nothing to enumerate beyond the generated CRUD surface.

## Boundary

Bunderstack stays hosting-neutral. It knows nothing about projects, deployments,
preview environments, MCP tokens, approvals, or Bunderhost.

```
Bunderstack        declares what the application needs and reports how it is running
      ^
Bunderhost         reads those declarations, holds the secrets, deploys, authorizes
      ^
MCP / agents       operate the host, never the framework
```

Everything about _authorization_ — scopes, approvals, audit, per-project grants,
secret storage — is Bunderhost's. Nothing in this design adds an actor model, a
capability registry, or agent tooling to the framework. The `examples/agent-chat`
capability layer stays a reference implementation and is explicitly not promoted
into the package by this work.

## Decisions

### 1. Blueprint parsing becomes forward-compatible

`parseBlueprint` uses `v.strictObject` everywhere, so a blueprint written by a
newer generator is rejected outright by an older host. Every object in the
blueprint schema becomes open (`v.objectWithRest(entries, v.unknown())`), keeping
unknown keys in the parsed value and in the serialized round-trip.

This is the enabling change: without it, each additive section below is a
breaking change for every already-deployed host. The blueprint stays
`version: 1`; the version is reserved for changes that remove or reinterpret an
existing field.

### 2. Environment entries declare secrecy and intent

`env` gains an optional `meta` map:

```ts
env: {
  server: { STRIPE_SECRET_KEY: v.string(), LOG_LEVEL: v.optional(v.string()) },
  client: { PUBLIC_APP_NAME: v.string() },
  meta: {
    STRIPE_SECRET_KEY: { description: 'Secret key from the Stripe dashboard' },
    LOG_LEVEL: { sensitive: false, description: 'debug | info | warn | error' },
  },
}
```

Rules:

- Default secrecy is by scope: `server` is sensitive, `client` is not.
- A client key may never be marked sensitive — it ships to the browser.
- A `meta` key that is not declared in `server` or `client` is an error.
- Descriptions are static prose, whitespace-collapsed, at most 200 characters.

Manifest and blueprint entries gain `sensitive` and an optional `description`.
The blueprint keeps both optional so blueprints generated before this release
still parse; `isSensitiveEnvVar(entry)` exports the scope-based default so hosts
encode it in exactly one place.

**Values never enter the blueprint.** This adds metadata about keys, nothing more.

### 3. The blueprint carries the application's own API operations

`bunderstack blueprint` already imports the entry module, so the application's
oRPC router is available statically. The blueprint gains an optional
`api.operations` array describing _application-declared_ procedures only:
`handle`, `operationId`, `method`, `path`, `summary`, and an `effect` of
`read | mutation | unknown`.

Generated CRUD, storage, and realtime routes are deliberately excluded: their
shapes are a fixed function of `resources.database.tables` and
`resources.storage.buckets`, which the blueprint already lists.

`effect` is derived from the declared HTTP method — `GET`/`HEAD`/`OPTIONS` are
reads, anything else is a mutation. A procedure that declares no route has
`effect: 'unknown'`, never `'read'`: guessing "read" for an undeclared method
would let a host treat a mutation as safe. Hosts must treat `unknown` as at
least as dangerous as `mutation`.

### 4. The runtime reports readiness, not just liveness

A new public `GET /api/readiness` returns a machine-readable report:

```json
{
  "status": "degraded",
  "revision": "0a8dc9f...",
  "checks": [
    { "name": "database", "status": "ok" },
    { "name": "schema", "status": "ok" },
    {
      "name": "background",
      "status": "degraded",
      "code": "backlog",
      "overdue": 12
    }
  ]
}
```

- `database` — one query against the internal jobs table proves the connection.
- `schema` — a missing-relation error from that same query means the app is
  serving traffic against an unprovisioned database.
- `background` — when queue jobs are declared, counts pending jobs whose `runAt`
  is more than 60s in the past. A backlog is the observable signature of a worker
  that is not running.
- `revision` — echoes `BUNDERSTACK_REVISION` when the host injects it, letting an
  agent confirm the deployed commit matches the one it asked for.

The response is always HTTP 200; the aggregate lives in `status`. `/api/health`
stays exactly as it is — infrastructure probes it, and changing its contract
would churn every existing deployment.

**No detail strings.** Check results carry a closed set of codes
(`unreachable`, `not_provisioned`, `backlog`) and never echo a driver error, a
connection string, or a stack trace. The endpoint is public.

## Explicitly out of scope

- Any MCP surface, tool, or transport.
- Actors, capabilities, grants, approvals, or audit records in the framework.
- Reading or exposing application data.
- Migration state in the readiness report — the deployer applies migrations and
  already knows their outcome; re-deriving it at runtime would need the migration
  journal on disk in the built image.
- Metrics and usage counters.

## Consumer follow-up (Bunderhost, separate work)

- Upgrade to the release produced by this plan before apps start emitting the new
  sections.
- Inject `BUNDERSTACK_REVISION` with the deployed commit SHA.
- Poll `/api/readiness` after cutover and treat `error` as a failed deploy.
- Drive the secret setup session from `sensitive`, and pre-fill non-sensitive keys.
- Gate the _agent features_ — not deployment — on `blueprint.generator.version`:
  an application built before 0.23.0 has no secrecy flags and no operation
  catalog, and must be reported as "needs a newer bunderstack" rather than as an
  application that declares no API. Deployment itself keeps working; only the
  new capabilities are unavailable.
