# Extensible Session User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `emailVerified` and expose explicitly mapped Better Auth user fields throughout Bunderstack's API context.

**Architecture:** Add a generic session-user mapping contract at the auth boundary, then carry its inferred return type through the resolver and API builder. The framework owns and normalizes base identity fields; applications opt additional fields in through `mapUser`.

**Tech Stack:** TypeScript, Better Auth, oRPC, Bun test.

**Spec:** `docs/superpowers/plans/2026-09-19-extensible-session-user-design.md`

## Global Constraints

- Work directly on `main` with explicit user approval.
- Use Bun commands.
- Follow red-green-refactor; no production changes before a failing test.
- Normalize missing or malformed `emailVerified` to `false`.
- Never expose the complete Better Auth user implicitly.

---

### Task 1: Standard verified-email identity

**Files:**

- Modify: `packages/bunderstack/src/auth-resolver.test.ts`
- Modify: `packages/bunderstack/src/scope.test.ts`
- Modify: `packages/bunderstack/src/access.ts`
- Modify: `packages/bunderstack/src/auth.ts`

**Interfaces:**

- Produces: backward-compatible `AccessUser` with `emailVerified?: boolean` and a
  resolver that always supplies a boolean.
- Produces: resolver users normalized with `emailVerified === true`.

- [x] Add runtime tests for `true`, `false`, and absent verification values.
- [x] Run the focused tests and confirm the new assertions fail because the field is absent.
- [x] Add `emailVerified` to the resolver boundary and returned access/session users.
- [x] Run the focused tests and confirm they pass.

### Task 2: Explicit mapped session fields

**Files:**

- Modify: `packages/bunderstack/src/auth-resolver.test.ts`
- Modify: `packages/bunderstack/src/api/define-api.test.ts`
- Modify: `packages/bunderstack/src/access.ts`
- Modify: `packages/bunderstack/src/auth.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/api/context.ts`
- Modify: `packages/bunderstack/src/api/builder.ts`
- Modify: `packages/bunderstack/src/api/types.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**

- Produces: `SessionUserConfig<TExtra>` with `mapUser(user): TExtra`.
- Produces: `AccessUser<TExtra>` and `AuthSessionResolver<TExtra>`.
- Produces: `ApiContext<..., TExtra>` whose session and protected user include mapped fields.

- [x] Add runtime tests for mapped fields and reserved-key protection.
- [x] Add compile-time API-context assertions for inferred mapped fields.
- [x] Run tests/typecheck and confirm failure from the missing API and types.
- [x] Implement the minimal generic mapping contract and runtime adapter.
- [x] Carry the generic through config, runtime, context, and builder types.
- [x] Run focused tests and package typecheck until green.

### Task 3: Published declaration verification

**Files:**

- Modify only if required by failures: public exports and consumer fixtures.

**Interfaces:**

- Consumes: public session-user types and inferred API context from Tasks 1-2.
- Produces: publishable `dist` declarations accepted by strict consumers.

- [x] Run `bun run build`.
- [x] Run `bun run verify:consumer`.
- [x] Run the complete package test and typecheck suites.
- [x] Review the final diff against the design and verify no raw Better Auth user is exposed without an explicit mapper or resolver, and no fail-open fallback remains.
