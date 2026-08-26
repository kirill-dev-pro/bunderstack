# Agent Run Suspend/Resume Design

**Status:** validated from the Work3 agent-chat review

## Goal

Make a tool approval suspend one durable logical agent run and resume that same
run after the user decides. A worker and model request may finish while waiting,
but the run, tool transcript, and remaining plan must not restart from the latest
user message.

## Design

AI SDK tool approval parts are the model-loop protocol. Required tools expose
`needsApproval`; a generation that proposes one returns a signed
`tool-approval-request` without executing the tool or continuing the loop. The
runtime freezes the exact tool call in `agent_requests`, stores the accumulated
model messages as the run checkpoint, changes the run to
`waiting_for_approval`, releases the thread lock, and produces no final assistant
message.

Approving or rejecting claims the request atomically and enqueues a resume job
for its existing `runId`. Approval authority remains in the app-local policy:
`allow_once` records a one-shot exact capability, `always_allow` also creates the
existing scoped grant, and rejection records a denial. The resumed model call
receives the checkpoint plus the matching `tool-approval-response`. Approved
calls execute through the existing `invokeAgentTool` boundary with the exact
capability; rejected calls are returned to the model as denied. Another approval
may suspend the same run again.

Normal user/system wakes still create a new run. Approval resolution never calls
the generic new-turn path.

## Tool contract

The model receives a concise operating contract generated beside the agent
definition. It explains that tools are the only application interface, that
ID-based mutations require discovery through `listTasks`, that an approval ends
the current model call and will be resumed automatically, and that it must not
claim completion before a tool result exists. Tool availability remains the
declaration allowlist; authorization is never delegated to the prompt.

## Persistence and failure rules

- `agent_runs` gains `waiting_for_approval` plus a JSON checkpoint.
- Pending approval requests store the AI SDK approval ID and exact tool call ID.
- Only one unresolved approval checkpoint is advanced at a time.
- A stale or replayed decision is inert.
- A resume failure keeps the run failed with its checkpoint for inspection.
- User-visible conversation stores only final assistant text; tool protocol
  parts stay in the run checkpoint/audit tables.

## Verification

Integration tests must prove that approval does not finish a run, that resolving
it resumes the same `runId`, that the frozen call executes once, that a second
approval suspends the same run again, and that rejection is visible to the
resumed model. Adapter tests must prove required tools use AI SDK approval and
that the operating contract reaches the model.
