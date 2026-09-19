# Extensible session user design

## Goal

Bunderstack must preserve Better Auth's standard `emailVerified` field and let
applications explicitly project additional authenticated-user fields into API
contexts without exposing the complete Better Auth user object.

## API

`AccessUser` keeps a stable framework-owned base: `id`, `email`, `name`, `role`,
and optional boolean `emailVerified` for source compatibility. Runtime session
resolution always sets it; missing or malformed values normalize to `false`.

Applications may declare a `session.mapUser` callback. Its return object is
intersected with `AccessUser` and becomes the user type returned by
`context.getSession()` and supplied to protected procedures. Framework-owned
keys cannot be overridden by the mapper.

The same session declaration can be reused by `defineApi` and `bunderstack` for
module-scope routers. Callback-form APIs infer it directly from the app config.

## Runtime flow

The Better Auth adapter reads the raw authenticated user, normalizes the base
fields, runs `mapUser` when configured, removes reserved base keys from the
mapped result, and returns the merged user through `AuthSessionResolver`.
`resolveAccessUser` and `resolveSession` retain that shape rather than rebuilding
and truncating it.

## Safety and compatibility

- `emailVerified` is fail-closed: only literal `true` becomes `true`.
- Extra fields are opt-in; the raw Better Auth object is never spread wholesale.
- `id`, `email`, `name`, `role`, and `emailVerified` remain framework-owned.
- Existing applications need no mapper and only gain the standard boolean.

## Testing

Runtime tests cover verified, unverified, missing verification, mapped fields,
and attempted reserved-key overrides. Compile-time tests prove mapped fields are
available in public and protected API contexts. The package build and strict
consumer verification validate emitted declarations.
