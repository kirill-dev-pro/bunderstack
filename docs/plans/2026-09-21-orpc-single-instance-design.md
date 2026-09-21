# oRPC Single-Instance Packaging Design

## Problem

`bunderstack@0.24.5` installs `@orpc/server` and `@orpc/client` as regular
dependencies while consuming the rest of the exact-version oRPC suite as peer
dependencies. When an application still has an older oRPC suite, Bun can place
the newer server below `bunderstack` while resolving
`@orpc/openapi/extensions/route` from the application. The extension patches a
different `Builder` prototype and `.route()` is missing at runtime.

## Design

Treat the complete synchronized oRPC suite as one host-owned runtime. Keep its
packages at exact `2.0.0-beta.37` versions in non-optional peer dependencies and
in development dependencies, but remove `@orpc/server` and `@orpc/client` from
regular dependencies. This makes Bunderstack and application-authored oRPC
middleware resolve the same package instances in a valid installation.

The dependency-boundary contract will reject any future reintroduction of
regular `@orpc/*` dependencies. The patch release will be `0.24.6`, with both
published changelogs describing the packaging correction.

## Verification

Run the dependency-boundary test through a red/green cycle, then run the full
test suite, type checking, consumer verification, build, and publish dry-run.
Publishing remains the repository's existing trusted-publishing workflow on a
push to `main`.
