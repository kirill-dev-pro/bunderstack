# Agent Run Suspend/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suspend and resume one durable agent run across sequential tool approvals while improving the model's tool operating contract.

**Architecture:** AI SDK approval parts stop the model loop. Bunderstack persists the exact request and model-message checkpoint on the existing run, then resumes that run after an atomic user decision with the existing policy and execution boundary.

**Tech Stack:** Bun, TypeScript, Drizzle/libSQL, AI SDK 7, Zod.

**Spec:** `docs/plans/2026-08-26-agent-run-suspend-resume-design.md`

## Global Constraints

- Keep the implementation app-local in `examples/agent-chat`.
- Preserve exact frozen-call authorization, grants, user scoping, and idempotent resolution.
- A waiting approval releases the worker/thread lock and does not create a final assistant message.
- Follow RED-GREEN TDD and use Bun commands.

---

### Task 1: Durable waiting run and checkpoint schema

**Files:**

- Modify: `examples/agent-chat/src/schema.ts`
- Modify: `examples/agent-chat/src/agent/schema.test.ts`
- Create: generated migration under `examples/agent-chat/migrations/`

**Interfaces:** `agentRuns.status` accepts `waiting_for_approval`; `agentRuns.checkpoint` stores JSON model messages; `agentRequests` stores `approvalId` and `toolCallId`.

- [x] Add a schema test inserting and reading a literal waiting checkpoint; run it and observe RED.
- [x] Add the columns/enums, generate the Drizzle migration, and rerun GREEN.

### Task 2: Model adapter approval boundary and tool contract

**Files:**

- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/agent/model.ts`
- Modify: `examples/agent-chat/src/agent/model.test.ts`
- Modify: `examples/agent-chat/src/agent/definition.ts`

**Interfaces:** The responder accepts optional checkpoint messages and approval responses and returns either `completed` with response messages or `waiting_for_approval` with the exact request and checkpoint. Required declared tools expose `needsApproval` through a runtime callback.

- [x] Add adapter tests proving required tools request approval and the result union preserves exact IDs/checkpoint; observe RED.
- [x] Implement the minimal adapter and operating contract; rerun GREEN.

### Task 3: Suspend/resume runtime

**Files:**

- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/approvals.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/approvals.test.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`

**Interfaces:** `runAgentTurn` may resume an existing `runId`; a waiting responder outcome updates that run and creates one request. `resolveApproval` records the decision/capability and enqueues `agentTurn` with the same `runId`, without executing or waking a new turn directly.

- [x] Add integration tests for waiting without final text, same-run resume, exact once execution, rejection, and a second sequential approval; observe RED.
- [x] Implement suspension/resumption and update the job input; rerun focused tests GREEN.

### Task 4: Documentation and verification

**Files:**

- Modify: `examples/agent-chat/README.md`

- [x] Correct the lifecycle documentation and describe same-run resume/tool contract.
- [x] Run agent-chat tests, typecheck, production build, migration consistency, and diff checks.
