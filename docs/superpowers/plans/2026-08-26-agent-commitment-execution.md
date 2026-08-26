# Agent Commitment Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-only reminders with durable app-local commitments that reliably execute notifications, exact tool calls, or trusted agent objectives across approvals and dependencies.

**Architecture:** `agent_commitments` owns scheduling and terminal state while `agent_runs` owns each execution attempt. Exact scheduled actions bypass model reinterpretation; objective executions enter the existing responder with a first-class trusted execution envelope. Approval resolution resumes the exact commitment execution, and independent commitment jobs remain runnable while others wait.

**Tech Stack:** Bun, TypeScript, Drizzle/libSQL, AI SDK 7, Zod.

**Spec:** `docs/plans/2026-08-26-agent-commitment-execution-design.md`

## Global Constraints

- Keep all production changes inside `examples/agent-chat`.
- Preserve the existing same-run AI SDK approval behavior for conversational turns.
- Follow RED-GREEN TDD with Bun.
- Do not treat assistant prose or successful job return as proof that a commitment objective completed.
- Do not add recurring schedules or automatic retry policy.
- Do not design or modify UI beyond keeping existing generated data readable.

---

### Task 1: Durable commitment state and execution schema

**Files:**

- Modify: `examples/agent-chat/src/schema.ts`
- Modify: `examples/agent-chat/src/agent/schema.test.ts`
- Create: generated migration under `examples/agent-chat/migrations/`

**Interfaces:**

- Produces `CommitmentExecutionSpec` JSON storage with `notify`, `tool_call`, and `objective` variants.
- Produces `agentCommitmentDependencies` and nullable `agentRuns.commitmentId`/`triggerType` columns.
- Commitment statuses become `pending | blocked | running | waiting_for_approval | completed | failed | cancelled`.

- [x] **Step 1: Write failing schema tests**

Add tests that insert three commitments with literal execution specs, link a dependent commitment, create a run linked to one commitment, and round-trip `result`, `error`, and lifecycle timestamps. The test must assert stored literal JSON and foreign-key ownership, not schema source text.

- [x] **Step 2: Run the schema test and observe RED**

Run:

```bash
bun test examples/agent-chat/src/agent/schema.test.ts
```

Expected: FAIL because the execution columns/table and run ownership do not exist.

- [x] **Step 3: Implement the schema**

Define app-local types and Drizzle columns. Retain `title` as a human-readable summary for existing reads, but make `executionSpec` the executable source of truth. Add dependency uniqueness on `(commitmentId, dependsOnCommitmentId)`.

- [x] **Step 4: Generate and verify migration**

Run:

```bash
bun run --cwd examples/agent-chat db:generate
bun test examples/agent-chat/src/agent/schema.test.ts
```

Expected: a new migration is generated and schema tests pass.

### Task 2: Commitment creation, listing, cancellation, and exact execution

**Files:**

- Create: `examples/agent-chat/src/agent/commitments.ts`
- Create: `examples/agent-chat/src/agent/commitments.test.ts`
- Modify: `examples/agent-chat/src/agent/definition.ts`
- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/src/test-app.ts`

**Interfaces:**

- Produces `createCommitment(ctx, input)`, `listCommitments(ctx, input)`, `cancelCommitment(ctx, input)`, `retryCommitment(ctx, input)`, `executeCommitment(ctx, input, responder)`.
- `createCommitment` validates `dependsOn` ownership and a schedulable exact tool/args pair before enqueueing `agentCommitment` with dedupe key `agent-commitment:<id>`.
- Exact execution creates one linked run and completes only after a durable tool result.

- [x] **Step 1: Write replay tests for exact scheduled work**

Add tests for these observable behaviors:

```text
createTask commitment: task count is 0 before execution and 1 afterward
remember commitment: memory count is 0 before execution and 1 afterward
duplicate execution: task count remains 1
cancelled commitment: no task is created
retryCommitment: creates a new attempt without erasing the failed attempt
listCommitments: returns persisted execution state
timezone validation: dueAt without an explicit offset is rejected
```

Use the real test database and real app-local tools. A responder must not be necessary for exact tool calls.

- [x] **Step 2: Run the commitment tests and observe RED**

Run:

```bash
bun test examples/agent-chat/src/agent/commitments.test.ts
```

Expected: FAIL because the commitment service and tools do not exist.

- [x] **Step 3: Implement exact commitment lifecycle**

Add a discriminated Zod schema:

```ts
type CommitmentExecutionSpec =
  | { kind: 'notify'; message: string }
  | { kind: 'tool_call'; tool: SchedulableToolName; args: unknown }
  | { kind: 'objective'; prompt: string }
```

For the first version, schedulable exact tools are `createTask`, `completeTask`, and `remember`. `deleteTask` remains schedulable but follows approval in Task 4. `createCommitment` rejects self/cross-owner dependencies, invalid exact arguments, and due times without an explicit `Z` or numeric UTC offset. `cancelCommitment` atomically updates only `pending` or `blocked` rows. `retryCommitment` accepts only terminal `failed` commitments, resets the aggregate for a new attempt, and retains prior `agent_runs` rows.

- [x] **Step 4: Wire app-local tools and job handler**

Replace `scheduleReminder` in the declaration with `createCommitment`, `listCommitments`, `cancelCommitment`, and `retryCommitment`. Register `agentCommitment` in the app and test app job maps. Keep a temporary compatibility mapping only if an existing test requires it; new model instructions must use commitments.

- [x] **Step 5: Run focused tests GREEN**

Run:

```bash
bun test examples/agent-chat/src/agent/commitments.test.ts examples/agent-chat/src/agent/declaration.test.ts
```

Expected: PASS.

### Task 3: Trusted objective execution and structured outcomes

**Files:**

- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/agent/context.ts`
- Modify: `examples/agent-chat/src/agent/model.ts`
- Modify: `examples/agent-chat/src/agent/model.test.ts`
- Modify: `examples/agent-chat/src/agent/commitments.ts`
- Modify: `examples/agent-chat/src/agent/commitments.test.ts`

**Interfaces:**

- Produces `currentExecution` as a trusted responder field distinct from supporting `context`.
- Objective execution returns `completed | waiting_for_approval | blocked | failed`.
- Background execution never derives its objective from `latestMessage`.

- [x] **Step 1: Write the failing trusted-trigger replay test**

Seed conversation history whose latest assistant message says to schedule another reminder. Execute an objective commitment whose prompt says to store a specific memory. Assert that the responder input objective equals the commitment prompt, `trigger.type` is `commitment`, and the real memory row is written. The production mutation caught by this test is restoring `latestMessage` as the background objective.

- [x] **Step 2: Write the failing model-boundary test**

Use a fake language model to assert that the active commitment objective is delivered as trusted instruction and inbox/history remain supporting data. Assert a structured terminal outcome rather than source prompt wording.

- [x] **Step 3: Run tests and observe RED**

Run:

```bash
bun test examples/agent-chat/src/agent/model.test.ts examples/agent-chat/src/agent/commitments.test.ts
```

Expected: FAIL because `currentExecution` and objective outcomes do not exist.

- [x] **Step 4: Implement the execution envelope**

Refactor responder input to contain:

```ts
currentExecution: {
  trigger: 'user_message' | 'commitment'
  runId: string
  commitmentId?: string
  objective: string
  executionSpec?: CommitmentExecutionSpec
}
```

Conversation, memory, inbox, tasks, and active commitments remain bounded supporting context. Remove the nonexistent `[System]: Reminder due:` contract. Objective execution uses the same tool registry and records its final summary/result on the commitment.

- [x] **Step 5: Run focused tests GREEN**

Run:

```bash
bun test examples/agent-chat/src/agent/model.test.ts examples/agent-chat/src/agent/context.test.ts examples/agent-chat/src/agent/commitments.test.ts
```

Expected: PASS.

### Task 4: Commitment approvals, independence, and dependencies

**Files:**

- Modify: `examples/agent-chat/src/agent/commitments.ts`
- Modify: `examples/agent-chat/src/agent/commitments.test.ts`
- Modify: `examples/agent-chat/src/agent/approvals.ts`
- Modify: `examples/agent-chat/src/agent/approvals.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`

**Interfaces:**

- Direct protected calls create approval requests with exact frozen arguments and set both run and commitment to `waiting_for_approval`.
- `resolveApproval` dispatches by run ownership: conversation run → `agentTurn`; commitment run → `agentCommitment`.
- Completion reevaluates only explicitly dependent blocked commitments.

- [x] **Step 1: Write failing multi-commitment approval tests**

Create two due delete commitments and one independent create commitment. Execute all three. Assert two distinct pending approval requests and one completed create commitment. Resolve one request and assert only its run resumes. Resolve the second and assert both exact deletions execute once.

- [x] **Step 2: Write failing dependency tests**

Create commitment B depending on A. Assert B becomes `blocked` when due before A completes, then becomes runnable after A completes. Also assert a failed/cancelled dependency does not silently execute B and cross-owner dependencies are rejected.

- [x] **Step 3: Run focused tests and observe RED**

Run:

```bash
bun test examples/agent-chat/src/agent/commitments.test.ts examples/agent-chat/src/agent/approvals.test.ts
```

Expected: FAIL on missing commitment-aware approval dispatch and dependency wakeup.

- [x] **Step 4: Implement approval dispatch and dependency reevaluation**

Create direct-call approval IDs/tool-call IDs, persist exact arguments, and release the thread lock while waiting. On resolution, enqueue the matching commitment execution with a per-request resume dedupe key. On completion, enqueue blocked dependents whose complete dependency set is now satisfied.

- [x] **Step 5: Run focused tests GREEN**

Run:

```bash
bun test examples/agent-chat/src/agent/commitments.test.ts examples/agent-chat/src/agent/approvals.test.ts examples/agent-chat/src/agent/runtime.test.ts
```

Expected: PASS.

### Task 5: Documentation and verification

**Files:**

- Modify: `examples/agent-chat/README.md`
- Modify: `docs/superpowers/plans/2026-08-26-agent-commitment-execution.md`

**Interfaces:** None.

- [x] **Step 1: Update example documentation**

Document notification, exact tool, and objective commitments; trusted execution input; approval suspension; independent commitments; dependencies; cancellation; and explicit terminal states. Remove claims that a reminder title is reinterpreted as a reliable future action.

- [x] **Step 2: Run complete agent-chat verification**

Run:

```bash
bun test examples/agent-chat/src
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
bun run --cwd examples/agent-chat build
bun run --cwd examples/agent-chat db:generate
bunx oxfmt --check examples/agent-chat docs/plans docs/superpowers/plans
git diff --check
```

Expected: agent-chat tests, typecheck, build, migration consistency, formatting, and diff checks pass; migration generation reports no remaining schema changes.

- [x] **Step 3: Run repository verification and separate baseline failures**

Run:

```bash
bun test
bun run typecheck:all
```

Expected: report any failures outside `examples/agent-chat` separately with exact file/test evidence rather than attributing them to this change.

- [x] **Step 4: Mark plan checkboxes complete**

Update this document only after each RED/GREEN cycle and verification has actually occurred.
