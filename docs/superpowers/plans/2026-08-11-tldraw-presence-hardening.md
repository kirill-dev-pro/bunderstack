# Tldraw Presence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generic CRUD failures typed and predictable while making the tldraw presence and wheel lifecycles safe under React remounts.

**Architecture:** Generic CRUD preserves REST semantics: duplicate creates are conflicts and empty sanitized updates are validation failures. Access configuration can explicitly opt a normally readonly timestamp into writes for a specific table. The tldraw example owns presence idempotency and DOM event behavior instead of changing create into a framework-wide upsert.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PGlite, oRPC, TanStack DB, React 19.

## Global Constraints

- Do not add dependencies.
- Do not use broad type assertions such as `as unknown as`.
- Preserve create and update authorization as separate operations.
- Keep stale presence expiration as the fallback for unclean disconnects.

---

### Task 1: Typed CRUD failures

**Files:**

- Modify: `packages/bunderstack/src/crud-operations.ts`
- Test: `packages/bunderstack/src/crud-operations.test.ts`

**Interfaces:**

- Produces: duplicate create throws `CrudOperationError` with code `CONFLICT`.
- Produces: update with no writable fields throws `CrudOperationError` with code `VALIDATION_ERROR`.

- [ ] Add a failing integration test that creates the same primary key twice and expects `CONFLICT` without changing the original row.
- [ ] Run the focused test and confirm the database exception escapes.
- [ ] Add a narrow unique-constraint detector for supported driver error shapes and translate only those errors.
- [ ] Add a failing integration test for an update whose fields are all removed by access sanitization.
- [ ] Run the focused test and confirm Drizzle rejects `.set({})`.
- [ ] Reject the empty update before executing SQL.
- [ ] Run the CRUD tests.

### Task 2: Per-table writable timestamp

**Files:**

- Modify: `packages/bunderstack/src/access.ts`
- Test: `packages/bunderstack/src/access-sanitize.test.ts`
- Modify: `examples/tldraw/src/access.ts`

**Interfaces:**

- Produces: a column explicitly listed in `writableColumns` overrides its default-readonly status, except `id` remains immutable during update.

- [ ] Add a failing sanitizer test showing explicit `writableColumns: ['updatedAt']` permits an update.
- [ ] Run the focused test and confirm `updatedAt` is stripped.
- [ ] Resolve readonly defaults so an explicit writable allowlist is authoritative while preserving immutable update IDs.
- [ ] Configure the presence table with the complete writable allowlist required by create, cursor movement, and heartbeat.
- [ ] Run access and type tests.

### Task 3: Idempotent presence and non-passive wheel

**Files:**

- Modify: `examples/tldraw/src/utils/presence.ts`
- Test: `examples/tldraw/src/utils/presence.test.ts`
- Modify: `examples/tldraw/src/routes/canvas.$id.tsx`

**Interfaces:**

- Produces: a small presence-join decision helper that inserts only when the local collection has no row for the presence ID.
- Produces: one native `wheel` listener registered with `{ passive: false }` that owns both cancellation and zoom calculation.

- [ ] Add a failing unit test for the presence-join decision helper.
- [ ] Implement the helper and use it to avoid duplicate optimistic inserts during React effect remounts.
- [ ] Move zoom handling into a stable native wheel effect and remove the JSX `onWheel` handler.
- [ ] Build and typecheck the tldraw example.

### Task 4: Verification

**Files:**

- Verify only.

- [ ] Run package tests for `bunderstack` and the tldraw presence utilities.
- [ ] Run workspace typechecks.
- [ ] Run the tldraw production build.
- [ ] Inspect the final diff for broad casts, accidental files, and semantic drift.
