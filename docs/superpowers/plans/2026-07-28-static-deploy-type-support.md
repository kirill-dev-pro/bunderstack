# Static Deploy Type Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve cron schedule literals in Bunderstack's public job-definition types so Bunderhost can recover schedules statically.

**Architecture:** Extend `CronDefinition` with a schedule type parameter and make the jobs builder's `cron` method use a const generic. Runtime values and behavior stay unchanged.

**Tech Stack:** Bun, TypeScript, `bun:test`

## Global Constraints

- Use Bun for installs, tests, scripts, and typechecking.
- Do not add a deployment CLI or runtime dependency.
- Preserve all existing job builder and runtime behavior.
- Use compile-time assertions that fail when a literal widens to `string`.

---

### Task 1: Preserve cron schedule literals

**Files:**
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/define.test.ts`

**Interfaces:**
- Consumes: existing `createJobsBuilder<TSchema, TEnvResult>()`.
- Produces: `CronDefinition<TSchema, TEnvResult, TSchedule>` and a `cron` builder whose returned `schedule` retains the input literal.

- [ ] **Step 1: Write the failing compile-time assertion**

Add local `Equal` and `Expect` helpers to `define.test.ts`, construct:

```ts
const defs = createJobsBuilder().define({
  cleanup: createJobsBuilder().cron({
    schedule: '0 4 * * *',
    handler: async () => {},
  }),
})
type _schedule = Expect<
  Equal<(typeof defs)['cleanup']['schedule'], '0 4 * * *'>
>
```

Use a single builder instance in the final test fixture.

- [ ] **Step 2: Run the TypeScript check and verify RED**

Run:

```sh
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: failure because `schedule` is currently inferred as `string`.

- [ ] **Step 3: Add the minimal generic**

Change the public type and builder to:

```ts
export type CronDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TSchedule extends string = string,
> = {
  kind: 'cron'
  schedule: TSchedule
  // existing handler
}

cron<const TSchedule extends string>(
  def: Omit<CronDefinition<TSchema, TEnvResult, TSchedule>, 'kind'>,
): CronDefinition<TSchema, TEnvResult, TSchedule>
```

Keep `BackgroundDefinition`, validation, runtime parsing, and handlers
structurally compatible.

- [ ] **Step 4: Verify GREEN**

Run:

```sh
bun test --cwd packages/bunderstack src/jobs/define.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
bun test --cwd packages/bunderstack
```

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/define.test.ts
git commit -m "feat(jobs): preserve cron schedule literals"
```
