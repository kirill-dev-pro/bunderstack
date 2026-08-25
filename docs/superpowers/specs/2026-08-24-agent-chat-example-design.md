# Agent Chat Example Design

**Date:** 2026-08-24
**Status:** approved through design discussion

## Goal

Add a minimal Bunderstack example that makes a long-lived agent observable. A
signed-in anonymous user chats with one personal agent, the agent manages a
small task list through tools, and a scheduled reminder can wake it after the
request that created the reminder has finished.

The example is an incubation surface, not a new framework API. Agent code stays
inside the example until the same boundary has survived a real application and
this reduced example.

## Runtime boundary

The example separates the durable agent instance from its presentation:

- `agentThreads` identifies the per-user long-lived agent and owns its turn
  lock and wake sequence.
- `agentMessages` is the human-visible conversation.
- `agentRuns` records each attempt to process a wake.
- `agentToolCalls` is the auditable effect journal.
- `agentCommitments` represents future work, initially scheduled reminders.
- `tasks` is the deliberately tiny application domain exposed through tools.

All wake sources enqueue the same `agentTurn` Bunderstack job. A stable dedupe
key collapses duplicate queued turns while `wakeSeq` preserves the fact that
another wake arrived during a running turn. The reminder job marks a commitment
fired, inserts a structured system message, then calls the same wake function.

## Model boundary

The runtime consumes an injected `AgentResponder`. Tests use a deterministic
responder that invokes real tools. Development without credentials uses a small
demo responder, so the example is runnable immediately. When
`OPENAI_API_KEY` is present, an AI SDK adapter supplies the same tools to an
OpenAI model. Provider selection is intentionally outside Bunderstack core.

## Domain-event decision

This version does not add domain events. A reminder job directly inserts the
system message and wakes the agent. That keeps the first example small and
lets the need for an event abstraction emerge from another concrete producer.

The README documents the future seam:

```text
domain write -> durable domain event -> matching agent inbox -> wake(agent)
```

A domain event would decouple the producer from the agent, preserve the reason
for a wake, support replay and multiple consumers, and allow a later declarative
table-change adapter. Raw database triggers are not proposed: applications
should first translate low-level changes into meaningful events such as
`saved_search.match` or `profile.completed`.

## UI direction

The page is an "agent desk": conversation on the left, a narrow runtime rail on
the right, and the task list below. The rail exposes state, the latest run, tool
effects, and scheduled commitments. A cool technical palette and restrained
monospace labels make the runtime legible without turning the example into a
dashboard template. The signature element is the visible wake line connecting
the chat to the runtime rail.

## Non-goals

- A published `bunderstack-agent` package.
- Automatic conversion of CRUD procedures into model tools.
- Dynamic subscriptions to table changes.
- Generic memory, multi-agent coordination, approvals, or streaming tokens.
- Persisting hidden model reasoning.
