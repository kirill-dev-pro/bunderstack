# Better Auth Types and Production Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve plugin-aware Better Auth types and remove Drizzle Kit from the production provisioning graph.

**Architecture:** Thread the resolved auth-config generic through Bunderstack's public type pipeline while keeping runtime construction and internal session resolution isolated. Split production migrations from development schema push into distinct package entrypoints with no production import edge to Drizzle Kit.

**Tech Stack:** TypeScript, Bun, Better Auth, Drizzle ORM/Kit, package exports.

**Spec:** `docs/superpowers/plans/2026-09-14-better-auth-provision-design.md`

## Global Constraints

- Work inline on `main` as explicitly requested.
- Use Bun for build and test commands.
- Preserve existing runtime behavior except that production `provision()` requires committed migrations.
- Validate emitted declarations through the consumer fixture.
- The production provision graph must contain no `drizzle-kit` input.

---

### Task 1: Preserve Better Auth configuration types

**Files:**

- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/auth.ts`
- Test: `packages/bunderstack/src/auth-types.test-d.ts`
- Modify: `scripts/verify-consumer.ts`

**Interfaces:**

- Produces: `AuthConfigInput<TSchema, TEnv, TAuthConfig>`, plugin-aware `BunderstackApp<..., TAuthConfig>`, exact `defineAuth` overloads.

- [ ] Add compile-time assertions for static and factory plugin configurations.
- [ ] Run the type test and confirm missing plugin endpoints and role fail.
- [ ] Add the exact auth generic to config, declaration, backend, runtime, and public app types.
- [ ] Preserve factory environment inference with a value-level `{ schema, env }` overload.
- [ ] Run package typecheck and confirm the source-level assertions pass.
- [ ] Add equivalent assertions to the emitted-declaration consumer fixture.
- [ ] Run `bun run build` and `bun run verify:consumer`.

### Task 2: Split production migrations from schema push

**Files:**

- Modify: `packages/bunderstack/src/provision.ts`
- Create: `packages/bunderstack/src/provision-schema.ts`
- Modify: `packages/bunderstack/package.json`
- Modify: `packages/bunderstack/src/provision.test.ts`
- Modify: `packages/bunderstack/src/provision.integration.test.ts`
- Modify: `packages/bunderstack/src/provision.pg.integration.test.ts`
- Modify: `scripts/bundle-boundaries.test.ts`

**Interfaces:**

- Produces: migration-only `bunderstack/provision`; development `bunderstack/provision-schema` exporting `provisionSchema` and `provision`.

- [ ] Add a bundle regression test requiring zero Drizzle Kit inputs from the production entrypoint.
- [ ] Add a runtime regression test for the missing-journal error.
- [ ] Run both tests and confirm they fail for the expected reasons.
- [ ] Move schema-push code to `provision-schema.ts` and make production provisioning migration-only.
- [ ] Update development tests and package exports.
- [ ] Run focused provisioning and boundary tests until green.
- [ ] Run the full package tests and typecheck.

### Task 3: Final package verification

**Files:**

- Modify generated `packages/bunderstack/dist/**` through the repository build only.

**Interfaces:**

- Consumes both completed fixes and verifies the published package contract.

- [ ] Run `bun run build`.
- [ ] Run `bun run verify:consumer`.
- [ ] Run `bun run test:bundles`.
- [ ] Run `bun run typecheck` and relevant package tests.
- [ ] Inspect `git diff` for accidental or generated unrelated changes.
