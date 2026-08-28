# Bunderstack 0.22.1 Testing Fixtures Design

## Goal

Make application tests concise enough to use the real Bunderstack runtime by
default. The patch must remain additive: every `backend.test(options)` call
valid in 0.22.0 remains valid in 0.22.1.

## Configured fixtures and lifecycle

`backend.test` remains callable and gains `configure(config)`. Configuration
contains the same `env`, `database`, and `logs` options as a single fixture,
plus an optional async `setup(fixture)` hook. The result is a callable factory.
Per-call options override configured defaults; `env` and `database` merge by
key rather than replacing the whole object.

The setup result is exposed as typed `fixture.context`. Every fixture also has
`defer(cleanup)`. Deferred callbacks run once in reverse registration order,
before the application and its database are closed. Setup failure closes the
partially configured fixture and preserves both the setup and cleanup errors.

## Auth identities

Email sign-up remains an HTTP request. The fixture adds HTTP-backed sign-in,
session lookup, sign-out, and verification-email traversal. Mock identities are
scoped by a unique test header and resolved from a per-fixture registry. Two
mock users can therefore coexist in one test; creating the second no longer
changes requests made with the first identity.

## Logs

Internal runtime logging goes through a small runtime reporter. Production uses
the existing console behavior. Test fixtures default to `capture`, expose
immutable entries through `fixture.logs`, and write nothing to the console.
`inherit` captures and forwards to the console; `silent` discards entries.
Application-owned console calls are deliberately outside this surface.

## Jobs

The private runtime testing handle exposes normalized queue rows. Public test
helpers provide `inspect(filter)`, `pending(filter)`, and `failed(filter)`.
Rows include id, declared name, cron kind, status, attempts, run time, dedupe
key, and last error. Filters support job name and dedupe key without exposing
the internal Drizzle table.

## Documentation and release

Update API reference, configuration/auth/background-jobs guides, README,
llms.txt, migration notes, and both changelogs. Publish only `bunderstack`
version 0.22.1 through the existing main-branch trusted-publishing workflow.
