# Better Auth typing and production provisioning design

## Goals

Preserve the exact Better Auth configuration type from a Bunderstack declaration through to `app.auth`, including plugin endpoints and plugin-added session fields. Keep Bunderstack's internal session resolver narrow.

Keep the production `bunderstack/provision` entrypoint free of every reference to `drizzle-kit`, while retaining development schema push through an explicit entrypoint.

## Better Auth type flow

Add an exact `TAuthConfig extends BetterAuthConfig` parameter to the auth input, declaration, backend factory, runtime materializer, and `BunderstackApp`. A factory input carries its return configuration type, never the factory type itself. `defineAuth` remains an identity helper and preserves the exact const config for both static and factory forms.

The runtime constructor may keep its implementation-level assertion because it adds the database adapter, email callbacks, and an OpenAPI plugin. The public type is derived from a named exported type that combines the declared plugin tuple with Bunderstack's guaranteed OpenAPI plugin. Internal consumers continue to use `AuthSessionResolver`.

Factory environment inference must have a value-level anchor. The existing `(schema, builder)` overload preserves schema typing; an additional `({ schema, env }, builder)` overload supplies application environment typing without forcing a custom helper.

## Provisioning entrypoints

`bunderstack/provision` becomes migration-only. It checks for the committed journal, applies migrations through the configured adapter, and throws an actionable error when the journal is absent.

Development schema push moves to `bunderstack/provision-schema`. That module owns the only `drizzle-kit/api` import and exports `provisionSchema()` plus a development `provision()` wrapper that keeps the old push-or-migrate behavior for explicitly development-oriented callers.

The production module must not statically or dynamically import the development module. Package exports and tests enforce this graph boundary.

## Verification

Compile-time tests cover static and factory configs, admin session roles, and representative admin, organization, MCP, two-factor, passkey, and OpenAPI endpoints. A built-declaration consumer fixture proves emitted `.d.ts` files preserve the types.

Bundle tests build the production provision entrypoint without externalizing `drizzle-kit` and reject any Drizzle Kit input. Runtime integration tests cover committed migrations and the missing-journal error; schema-push tests import the development entrypoint.
