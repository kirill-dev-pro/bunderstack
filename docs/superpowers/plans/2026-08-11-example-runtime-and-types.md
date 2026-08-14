# Example Runtime and Type Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shipped example build successfully after the oRPC migration, prevent duplicate TanStack DB runtimes, and remove avoidable unsafe casts from example application code.

**Architecture:** Treat each example's own build as its executable contract. Add one focused integration regression around the shared sync client and React DB boundary, then fix the dependency identity at the consumer boundary with a direct peer dependency and Vite deduplication. Replace example-level `any` and `as unknown as` with inferred row types, React types, and router-safe navigation wherever the libraries expose enough information.

**Tech Stack:** Bun, TypeScript, Vite, TanStack DB/React DB/Router, React, SolidJS, oRPC.

## Global Constraints

- Preserve the user's existing modification to `examples/tldraw/src/routeTree.gen.ts`.
- Do not weaken compiler options or suppress diagnostics.
- Keep casts only where two external libraries expose nominally incompatible types; list every remaining production `as unknown as` in the final summary.
- Verify all six packages under `examples/` with their declared `build` scripts.

---

### Task 1: TanStack collection runtime identity

**Files:**

- Create: `examples/tldraw/src/utils/collection-identity.test.ts`
- Modify: `examples/tldraw/package.json`
- Modify: `examples/tldraw/vite.config.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: `createSyncClient<TApp>({ queryClient, realtime: false })` and `CollectionImpl` exported by `@tanstack/react-db`.
- Produces: a collection accepted by React DB's nominal runtime check.

- [x] **Step 1: Write the failing integration test**

```ts
test('sync collections use the React DB Collection runtime', () => {
  const api = createSyncClient<any>({
    queryClient: new QueryClient(),
    realtime: false,
  })
  expect(api.canvas.collection).toBeInstanceOf(CollectionImpl)
})
```

- [x] **Step 2: Run the test and verify it fails with the cross-runtime constructor mismatch**

Run: `bun test src/utils/collection-identity.test.ts`

- [x] **Step 3: Add `@tanstack/db@0.6.16` to the example and configure `resolve.dedupe: ['@tanstack/db']`**

- [x] **Step 4: Reinstall the workspace and rerun the test until it passes**

Run: `bun install && bun test src/utils/collection-identity.test.ts`

### Task 2: Remove unsafe example casts

**Files:**

- Modify: `examples/tldraw/src/routes/canvas.tsx`
- Modify: `examples/tldraw/src/routes/canvas.$id.tsx`
- Modify: other files under `examples/` and `templates/tanstack-start-saas/src/` identified by the production cast audit.

**Interfaces:**

- Consumes: inferred `TableCollection` row types and router-generated route types.
- Produces: live-query results and component state whose types are inferred without `as unknown as` or `any` escape hatches.

- [x] **Step 1: Run TypeScript with the tldraw casts removed and capture the exact inference failures**

Run: `bun run --cwd examples/tldraw build`

- [x] **Step 2: Express collection aliases with supported generic/query-builder types and remove result-array recasts**

- [x] **Step 3: Replace avoidable `any` in example/template React props, rows, drag events, and router calls with concrete or inferred types**

- [x] **Step 4: Run the affected example builds after each group of edits**

### Task 3: Full example verification

**Files:**

- Modify only files implicated by a reproducible build/runtime failure.

**Interfaces:**

- Consumes: each example's declared `build` script.
- Produces: six independently buildable example applications.

- [x] **Step 1: Run all example builds and record each failure by project**

- [x] **Step 2: For every new failure, add the narrowest reproducible check before changing production code**

- [x] **Step 3: Implement one root-cause fix at a time and rerun the affected build**

- [x] **Step 4: Run the workspace typecheck, boundary tests, bundle tests, and full test suite**

- [x] **Step 5: Audit remaining production `as unknown as` occurrences and summarize only the irreducible external-library boundaries**
