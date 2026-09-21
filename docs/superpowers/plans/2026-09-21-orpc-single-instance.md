# oRPC Single-Instance Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Bunderstack from loading an isolated oRPC server instance that is not patched by the OpenAPI route extension.

**Architecture:** Make the synchronized oRPC suite host-owned through exact, non-optional peer dependencies. Retain development dependencies for local builds and tests, and guard the package boundary with a manifest contract test.

**Tech Stack:** Bun, TypeScript, oRPC, npm trusted publishing

**Spec:** `docs/plans/2026-09-21-orpc-single-instance-design.md`

## Global Constraints

- All `@orpc/*` peer and development dependency versions remain exactly `2.0.0-beta.37`.
- `@orpc/server` and `@orpc/client` must not be regular dependencies.
- Release version is `0.24.6`.

---

### Task 1: Enforce peer-only oRPC runtime ownership

**Files:**
- Modify: `scripts/dependency-boundaries.test.ts`
- Modify: `packages/bunderstack/package.json`

**Interfaces:**
- Consumes: the published package manifest
- Produces: a manifest with no regular `@orpc/*` dependencies

- [ ] Change the dependency-boundary expectation so regular dependencies contain no `@orpc/*` package.
- [ ] Run `bun test scripts/dependency-boundaries.test.ts` and confirm it fails on the current manifest.
- [ ] Remove `@orpc/server` and `@orpc/client` from regular dependencies.
- [ ] Run the focused test and confirm it passes.

### Task 2: Prepare and verify patch release

**Files:**
- Modify: `packages/bunderstack/package.json`
- Modify: `CHANGELOG.md`
- Modify: `packages/bunderstack/CHANGELOG.md`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: the peer-only manifest from Task 1
- Produces: publishable `bunderstack@0.24.6`

- [ ] Set the package version to `0.24.6` and update the lockfile.
- [ ] Add the packaging fix to both changelogs.
- [ ] Run `bun run test`, `bun run typecheck:all`, `bun run verify:consumer`, `bun run build`, and `bun scripts/publish-changed.ts --dry-run`.
- [ ] Commit and push the verified release to `main`.
- [ ] Wait for the publish workflow and verify `bunderstack@0.24.6` on npm.
