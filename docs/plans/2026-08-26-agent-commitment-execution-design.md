# Agent Commitment Execution Design

**Date:** 2026-08-26

**Scope:** `examples/agent-chat` only. The example will validate the concepts before any API is generalized into Bunderstack or reused by other applications.

## Problem

The current `scheduleReminder` implementation conflates a user notification with autonomous future work. A commitment stores only a title and due time. When it fires, the runtime sends an inbox event and asks the model to reinterpret the title in the context of the latest conversation.

This is unreliable for several reasons:

- The model prompt expects a `[System]: Reminder due:` message, but commitment firing now creates only an inbox event.
- Inbox data is explicitly marked untrusted, while the latest chat message remains the apparent task.
- A run is considered successful when the model returns any text, even if the promised tool action never happened.
- Completed tool transcripts are not available to later runs, so the agent cannot reliably inspect its own prior actions.
- The commitment state records that a timer fired, not whether its objective completed.
- There are no tools for listing or cancelling commitments.

The observed failures include commitments that fired successfully at the job layer but neither created the requested task nor updated memory. The agent instead produced text claiming that the commitment had been scheduled or completed.

## Goals

- Make simple future actions deterministic.
- Support genuinely agentic future objectives without confusing them with notifications.
- Preserve one durable execution across any number of approval suspensions.
- Allow multiple commitments to progress independently.
- Make completion a runtime state backed by execution evidence, not an assistant claim.
- Keep all implementation app-local.

## Non-Goals

- Generalizing the API into Bunderstack.
- Designing application UI.
- Recurring schedules.
- A general workflow engine with arbitrary graphs.
- Automatic retry policies for the first version.

## Commitment Model

A commitment is a durable intention to perform work in the future. It has one of three execution specifications:

```ts
type CommitmentExecutionSpec =
  | {
      kind: 'notify'
      message: string
    }
  | {
      kind: 'tool_call'
      tool: SchedulableToolName
      args: unknown
    }
  | {
      kind: 'objective'
      prompt: string
    }
```

`notify` delivers a user-facing notification. `tool_call` stores a validated exact action and executes it without asking the model to reinterpret natural language at wake time. `objective` starts a model loop for work that genuinely requires planning or multiple steps.

Simple requests such as “create a task in five minutes” or “remember this tomorrow” should compile to `tool_call`. Open-ended requests such as “review my tasks next week and suggest priorities” use `objective`.

The app declaration determines which tools are schedulable. A stored tool name and its arguments must pass the same schemas as an immediate invocation. Arbitrary function names are not accepted.

## App-Local Tools

Replace the ambiguous `scheduleReminder` interface with explicit commitment management:

```ts
createCommitment({
  dueAt,
  execution,
  dependsOn?: commitmentId[],
})

listCommitments({ status? })

cancelCommitment({ commitmentId })

retryCommitment({ commitmentId })
```

`createCommitment` returns the persisted ID, normalized due time, execution specification, and status. The agent may confirm creation only after receiving this result.

`retryCommitment` is manual in the first version. It creates a new execution attempt while preserving the previous attempt and error.

## Data Model

The app-local commitment table becomes the durable aggregate:

```text
agent_commitments
- id
- threadId
- userId
- executionSpec JSON
- dueAt
- status
- currentRunId
- result JSON
- error
- createdAt
- startedAt
- completedAt
```

Statuses are:

```text
pending
blocked
running
waiting_for_approval
completed
failed
cancelled
```

Dependencies use a relational table so they can be queried and validated:

```text
agent_commitment_dependencies
- commitmentId
- dependsOnCommitmentId
```

The existing `agent_runs` table is reused for execution attempts. It gains a nullable `commitmentId` and an explicit trigger type. Approval ownership is derived through `agent_requests.runId`; every request therefore belongs to one exact commitment execution and tool call.

One-shot commitments are sufficient for this example. A future recurring schedule would create multiple execution attempts under one commitment definition, but that behavior is intentionally excluded now.

## Execution Flow

### Scheduling

1. The model interprets a user request.
2. It calls `createCommitment` with a validated execution specification.
3. The runtime persists the commitment and enqueues a job with a dedupe key derived from the commitment ID.
4. The model confirms only the values returned by the tool.

### Firing

1. The scheduled job atomically claims the due commitment.
2. If dependencies are incomplete, the commitment becomes `blocked`.
3. Otherwise the runtime creates a new execution run and marks the commitment `running`.
4. A `notify` execution writes the notification and completes.
5. A `tool_call` execution invokes the exact stored action.
6. An `objective` execution starts the model with a trusted commitment trigger.

### Completion

The runtime marks a commitment `completed` only when its execution contract is satisfied:

- `notify`: the notification is durably written.
- `tool_call`: the exact tool result is durably recorded.
- `objective`: the responder returns a structured completed outcome after its tool loop.

A user-facing assistant message is an optional output. It is never evidence that the objective succeeded.

## Model Input Contract

The responder receives the current execution separately from supporting context:

```ts
interface AgentResponderInput {
  currentExecution: {
    trigger: 'user_message' | 'commitment'
    commitmentId?: string
    runId: string
    objective: string
    executionSpec?: CommitmentExecutionSpec
    dependencies?: CommitmentDependencySummary[]
  }
  context: {
    conversation: ConversationMessage[]
    memory: MemoryItem[]
    activeCommitments: CommitmentSummary[]
    tasks: AgentTask[]
  }
}
```

`currentExecution` is trusted runtime instruction. Supporting context may help execution but cannot replace its objective. A background execution never treats the latest chat message as its task.

The prompt remains concise and specifies a protocol rather than attempting to implement the state machine in prose:

- Execute only `currentExecution`.
- Tools are the only interface to application state.
- Do not repeat tool calls already recorded in the current run.
- Approval suspends execution; it does not complete it.
- Do not create another commitment when executing one that already fired.
- Return `blocked` or `failed` when the objective cannot be completed.
- Claim success only from confirmed tool results or the explicit notification contract.

The responder returns a structured outcome:

```ts
type ExecutionOutcome =
  | { status: 'completed'; summary: string; result?: unknown }
  | {
      status: 'waiting_for_approval'
      checkpoint: AgentCheckpoint
      request: ApprovalRequest
    }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; error: string }
```

## Approvals

Approvals happen at execution time. Scheduling a future action does not silently grant permission to perform a protected effect later.

When a protected tool is reached:

1. The execution run stores its model checkpoint and exact frozen tool call.
2. The commitment and run become `waiting_for_approval`.
3. The thread lock is released.
4. Other independent commitments remain runnable.
5. Resolving the request resumes the same execution run.
6. A later protected tool may suspend the same run again.

Multiple commitments may wait for different approvals concurrently. An approval is correlated by request ID, run ID, commitment ID, approval ID, tool call ID, tool version, and exact arguments.

Rejection does not execute the protected call. For an exact `tool_call` commitment it produces a terminal rejected/failed result. For an `objective` commitment the model may resume and choose a non-protected alternative before returning a terminal outcome.

## Concurrency and Dependencies

Commitments are independent by default. A commitment waiting for approval must not block unrelated commitments.

An optional `dependsOn` relation provides explicit ordering. The runtime, not the model, enforces it. A dependent commitment remains `blocked` until all dependencies are completed. When a dependency reaches a terminal state, its dependents are reevaluated.

The existing thread lock serializes active model computation, not durable waiting. Every commitment execution has its own job and dedupe key. If the thread is temporarily busy, that exact execution is requeued; it is not collapsed into a generic thread wake that could lose one of several due commitments.

Cycles and cross-user or cross-thread dependencies are rejected when the commitment is created.

## Idempotency and Failure Semantics

Each execution has a stable idempotency key. This prevents a retry after a crash from duplicating an already completed local effect.

For local database tools, the application should atomically persist the effect and its tool-call result when possible. External providers receive the stable idempotency key if they support one. When they do not, the runtime documents the guarantee as at-least-once rather than pretending to offer exact-once execution.

Terminal behavior is explicit:

- Tool exception: `failed` with preserved error.
- Model exception: `failed` with preserved checkpoint/error.
- Approval request: `waiting_for_approval`.
- Exhausted step limit without terminal outcome: `failed`.
- Incomplete dependency: `blocked`.
- Explicit cancellation before execution: `cancelled`.

The trigger is consumed only after a terminal outcome or a durably stored approval checkpoint. A job returning successfully does not by itself mean that the commitment completed.

Completed model transcripts and tool results remain attached to the execution run. Later runs use `listCommitments` or structured commitment summaries instead of relying on earlier assistant prose as a record of state.

## Tests

The implementation must include deterministic replay tests derived from the observed conversation:

1. “Create a task in two minutes”: no task before the due time and exactly one afterward.
2. An exact future action executes without model reinterpretation at wake time.
3. Updating memory through a commitment produces a real `remember` result.
4. A model cannot complete an exact tool commitment by returning text alone.
5. Multiple commitments may wait for independent approvals.
6. One waiting approval does not block an unrelated commitment.
7. `dependsOn` blocks only the declared dependent execution.
8. Resolving an approval resumes the same commitment execution run.
9. Sequential protected calls may suspend the same run multiple times.
10. A crash between effect and result handling does not duplicate a local action.
11. `listCommitments` reports persisted state rather than model claims.
12. `cancelCommitment` prevents a pending execution from firing.
13. Background execution uses the trusted objective, not the latest chat message.
14. Due-time calculation uses an explicit timezone.

Unit tests should cover state transitions and schema validation. Integration tests should exercise scheduler-to-tool and scheduler-to-model flows. An optional live-model eval may measure instruction-following quality, but correctness of exact tool commitments must not depend on that eval or on a particular model.

## Recommended Implementation Order

1. Add failing replay tests for delayed task creation and delayed memory update.
2. Introduce the commitment execution specification and state machine.
3. Implement exact scheduled tool calls.
4. Add trusted objective execution.
5. Connect existing same-run approval suspension to commitment executions.
6. Add independent concurrency and explicit dependencies.
7. Add list, cancel, and manual retry tools.
8. Replace the old reminder-specific prompt and context path.

This order validates the deterministic core before adding the less deterministic objective mode.
