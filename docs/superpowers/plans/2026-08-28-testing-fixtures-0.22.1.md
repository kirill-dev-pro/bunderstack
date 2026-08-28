# Bunderstack 0.22.1 Testing Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configured fixture factories, lifecycle hooks, scoped auth helpers, captured runtime logs, and inspectable jobs, then release bunderstack 0.22.1 and migrate Bunderhost.

**Architecture:** Keep `backend.test()` backward-compatible and attach a typed `configure()` method to the callable test function. Test-only controls are supplied through runtime overrides and remain absent from production app objects.

**Tech Stack:** Bun, TypeScript, Drizzle, Better Auth, oRPC.

**Spec:** `docs/plans/2026-08-28-testing-fixtures-0.22.1-design.md`

## Global Constraints

- Existing `backend.test(options)` source compatibility is required.
- New runtime resources must be owned by `TestFixture.close()` and async disposal.
- Production logging behavior must remain unchanged.
- Publish `bunderstack` exactly as version `0.22.1` through the existing workflow.

---

### Task 1: Configured fixture factory and lifecycle

**Files:**
- Modify: `packages/bunderstack/src/backend.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Test: `packages/bunderstack/src/testing/fixture.test.ts`

**Interfaces:**
- Produces: `backend.test.configure({ env, database, logs, setup })`
- Produces: `fixture.defer(cleanup)` and typed `fixture.context`

- [ ] Add a failing test that configures default env/database options, overrides one env key per call, returns `{ marker }` from setup, and verifies LIFO cleanup.
- [ ] Run `bun test packages/bunderstack/src/testing/fixture.test.ts` and confirm the missing `configure` API fails.
- [ ] Implement `TestMethod`, `TestFactory`, option merging, setup error cleanup, and idempotent deferred cleanup.
- [ ] Run the focused test and typecheck.

### Task 2: Scoped auth and email flows

**Files:**
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/testing/auth.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Test: `packages/bunderstack/src/testing/auth-client.test.ts`

**Interfaces:**
- Produces: `signInEmail`, `getSession`, `signOut`, `verifyEmail`
- Produces: header-scoped `mockSession(user, session?)`

- [ ] Add failing tests with two simultaneous mock identities and a complete sign-up → verify → sign-out → sign-in flow.
- [ ] Run the auth test and confirm the missing helpers/scoping fail.
- [ ] Add a fixture auth resolver override and implement the HTTP helpers.
- [ ] Run the focused auth tests and typecheck.

### Task 3: Captured runtime logs

**Files:**
- Create: `packages/bunderstack/src/logging.ts`
- Create: `packages/bunderstack/src/testing/logs.ts`
- Modify: `packages/bunderstack/src/errors.ts`
- Modify: `packages/bunderstack/src/api/context.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Test: `packages/bunderstack/src/testing/logs.test.ts`

**Interfaces:**
- Produces: `TestOptions.logs: 'capture' | 'inherit' | 'silent'`
- Produces: `fixture.logs.entries`, `errors`, `warnings`, and `clear()`

- [ ] Add failing tests proving capture is quiet, inherit forwards, silent discards, and clear removes captured entries.
- [ ] Run the logs test and confirm the surface is missing.
- [ ] Route Bunderstack runtime/API/job diagnostics through a runtime reporter and create the test sink.
- [ ] Run focused logging/error tests and typecheck.

### Task 4: Job inspection

**Files:**
- Modify: `packages/bunderstack/src/backend-internals.ts`
- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/testing/jobs.ts`
- Test: `packages/bunderstack/src/testing/jobs.test.ts`

**Interfaces:**
- Produces: `TestJob`, `TestJobFilter`
- Produces: `jobs.inspect(filter)`, `jobs.pending(filter)`, `jobs.failed(filter)`

- [ ] Add failing tests for pending name/dedupe filtering and failed-row inspection.
- [ ] Run the job test and confirm the methods are missing.
- [ ] Return normalized rows from the private handle and implement public filtering.
- [ ] Run focused job tests and typecheck.

### Task 5: Documentation, release, and Bunderhost adoption

**Files:**
- Modify: `packages/bunderstack/package.json`
- Modify: `packages/bunderstack/README.md`
- Modify: `packages/bunderstack/llms.txt`
- Modify: `packages/bunderstack/CHANGELOG.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/MIGRATION-0.22.md`
- Modify: `website/content/docs/api-reference.mdx`
- Modify: `website/content/docs/configuration.mdx`
- Modify: `website/content/docs/auth.mdx`
- Modify: `website/content/docs/background-jobs.mdx`
- Modify in Bunderhost: `package.json`, `bun.lock`, test fixtures

- [ ] Document every public method with a complete configured-fixture example.
- [ ] Set package version to `0.22.1` and run `bun test`, `bun run typecheck:all`, `bun run build`, and `bun run verify:consumer`.
- [ ] Commit and push Bundlerstack main; wait for the publish workflow and verify npm reports `0.22.1`.
- [ ] Install `bunderstack@^0.22.1` in Bunderhost, consolidate repeated fixture setup with `backend.test.configure`, and run its test/typecheck/build checks.
- [ ] Commit and push Bunderhost main without including unrelated OG-image changes.
