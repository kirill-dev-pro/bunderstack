# Agent Chat Durable Streaming Design

**Date:** 2026-08-30
**Status:** approved through design discussion

## Goal

Make the `examples/agent-chat` conversation feel live without making the
browser responsible for an agent turn. The user should see durable activity
steps followed by smoothly appearing answer text. Reloading a tab, navigating
to another chat, suspending a mobile browser, or losing the SSE connection must
not stop generation or lose the observable state of the turn.

This remains an app-local experiment. It should validate the design against a
real Bunderstack job and realtime transport before any streaming-agent API is
proposed for the framework.

## Reliability contract

The database is the source of truth. Realtime is a low-latency notification
path, not the only copy of an answer.

The supported failure boundary is the connection between the browser and the
application. Worker crashes and provider-stream continuation are not part of
this version. While the worker and provider request remain healthy:

- disconnecting the browser never cancels the agent job;
- a newly opened client can reconstruct every visible part of the turn from
  the database;
- Publisher replay makes short reconnects efficient;
- the mandatory refetch after reconnect restores correctness when replay has
  expired;
- stale or reordered realtime updates cannot replace a newer snapshot.

The existing request-bound shape is therefore not suitable:

```text
POST request -> model stream -> browser response
```

Sending a command and observing its result become independent operations:

```text
POST sendMessage -> durable rows + queued job -> 202 Accepted

worker -> model stream -> durable snapshots -> realtime publications

browser -> initial query -> realtime updates -> reconnect refetch
```

## Data model

### Messages

`agentMessages` remains the visible conversation. It gains the fields needed
for a server-owned assistant draft:

- `clientMessageId`: supplied for user messages and unique within a thread;
- `runId`: set on an assistant message produced by a run;
- `status`: `queued | streaming | complete | cancelled | error`;
- `revision`: a monotonically increasing integer;
- `updatedAt`: the time of the latest durable snapshot.

The existing `content` column is the canonical answer snapshot. The worker
creates an empty assistant message before it begins model generation. It then
updates that same row rather than creating an assistant message only after the
model finishes.

`clientMessageId` makes message submission idempotent. If a browser retries
because it did not receive the acceptance response, the procedure returns the
already-created message, run, and assistant draft instead of starting a second
logical turn.

### Runs

`agentRuns` owns the server-side lifecycle:

```text
queued -> running -> complete
                  -> cancelling -> cancelled
                  -> error
```

It records the assistant message ID as well as its existing thread, user,
reason, checkpoint, and timing information. A thread may have at most one
active run. This continues to be enforced by the existing thread lock rather
than by introducing a new turn entity.

### Observable steps

A new app-local `agentRunSteps` table stores the safe, user-visible activity
timeline:

- `id`, `runId`, and monotonic `sequence`;
- `kind`: `status | reasoning_summary | tool_call | retrieval`;
- `title` and optional structured `detail`;
- `status`: `running | complete | failed | cancelled`;
- optional input and output summaries;
- `visibility`: `visible | hidden`;
- start and completion timestamps.

The table is not a store for hidden chain-of-thought. It records observable
work: brief reasoning summaries emitted for display, searches, retrieval,
tool calls, and their outcomes. The technical example sets every tool step to
`visible` and shows its exact tool name, version, arguments, result, duration,
and status. The visibility field leaves a production application free to hide
sensitive steps.

Existing `agentToolCalls` remains the authoritative effect journal. A tool
step links to it rather than replacing its execution and idempotency role.

## Message acceptance

`sendMessage` accepts the text and a browser-generated `clientMessageId`. In
one database transaction it:

1. finds or creates the user's thread;
2. inserts the user message;
3. creates a queued run;
4. creates its empty queued assistant draft;
5. commits the three linked records.

It then enqueues `agentTurn` with an idempotent execution identity and returns
the three IDs. The mutation response is an acknowledgement, not a model
stream. Once accepted, a client observes the run and must never resend the
user's text merely because a realtime connection timed out.

The UI may optimistically render the submitted user message, but confirmed
database rows replace that local representation through normal Bunderstack
query reconciliation.

## Worker streaming

The model adapter changes from `generateText()` to `streamText()`. The worker,
not the HTTP response, owns and consumes the result stream. It accumulates
answer text in memory and flushes a canonical snapshot approximately every
100–200 ms:

1. update the assistant message content;
2. increment its revision;
3. set the status to `streaming`;
4. publish the returned canonical row through `ctx.realtime.publish()`.

The interval is a pacing target, not a protocol guarantee. Flushing by word or
small text group gives a smooth display without storing every token as a row.
The last snapshot is always awaited before the message and run become
`complete`.

Tool activity uses the same pattern. Starting an action creates a running step;
progress may update it; completion stores the result summary and publishes the
canonical row. The underlying tool call continues to write its existing audit
record.

For separate web and worker processes, Redis realtime is required. The database
contract remains correct without event replay, but Redis supplies live fan-out
while the job runs.

## Realtime recovery

The browser reads messages, runs, steps, requests, and tool calls through
Bunderstack queries. The standard realtime client applies publications,
reconnects with the last Publisher event ID, and refetches subscribed tables
after reconnect.

Each message update carries its database revision. A client applies an update
only when its revision is greater than the revision it currently holds. This
prevents an older buffered event from replacing a newer row obtained by
refetch.

Recovery does not replay text character by character. On reload or wake, the
full latest database snapshot appears immediately. Only subsequent small live
increments receive the typing animation. This keeps the screen current while
still making active generation feel fluid.

The UI may show a quiet `Reconnecting...` transport hint, but a connection
failure does not change the run or message status. Those statuses describe
server work, not browser connectivity.

## Activity and answer presentation

Before answer text exists, the activity panel is expanded and emphasizes the
currently running step. Completed steps remain above it. Example content is:

```text
✓ Analysed the request
✓ listTasks v1 ({}): 3 tasks
● Preparing the answer
```

When the first meaningful answer text is stored, the activity panel
automatically collapses to a compact summary such as `5 steps · 2 tools`.
The user can expand it at any time. The default after recovery is derived from
durable state: an active run with no answer is expanded; a run whose answer has
started is collapsed. A manual expansion preference may remain local UI state.

Partial Markdown is rendered tolerantly while streaming. The canonical content
must never be delayed merely to complete a Markdown construct.

## Cancellation

Stopping generation is a durable protected procedure, not a browser-only
abort. `stopRun(runId)` conditionally changes `queued` to `cancelled` or
`running` to `cancelling`.

The worker owns the provider `AbortController`. During its normal snapshot
flush it observes `cancelling`, aborts the model stream, awaits its final
durable writes, and marks the run, assistant message, and current step
`cancelled`. Already generated text remains visible with a `Stopped by user`
annotation.

Cancellation is idempotent. Conditional terminal updates settle the race with
normal completion: a stop request made after `complete` does not rewrite the
finished run. The UI continues observing realtime until it sees a confirmed
terminal state; clicking Stop does not close its subscription.

## One browser-local queued message

While a run is active, the user may prepare and queue one additional message.
This queue is intentionally browser-local React state. It is displayed below
the active response with a subdued, ephemeral treatment and two actions:

- `Send now`;
- `Remove from queue`.

No server row exists yet. Reloading the page discards this message by design.
It is not stored in local or session storage.

After the current run reaches `complete`, `cancelled`, or `error`, the browser
submits the queued message through the ordinary idempotent `sendMessage`
procedure. `Send now` first calls `stopRun`, waits until the current run is
confirmed terminal through realtime or refetch, and only then submits the
queued message. It must not start the next turn concurrently with cancellation.

Supporting multiple queued browser messages, editing a server-side queue, and
restoring queued input after reload are explicit non-goals.

## Error behavior

- A browser disconnect is a transport condition, not a run error.
- A failed submission before acceptance leaves the text in the composer and
  may be retried with the same `clientMessageId`.
- An accepted submission is never automatically resubmitted. The client looks
  up its confirmed run instead.
- A model or tool error writes an `error` terminal status and preserves all
  durable text and steps accumulated before the failure.
- A stale update is ignored by revision.
- A missed replay window is repaired by the reconnect refetch.

Automatic worker-attempt recovery and provider continuation are outside this
design. They can later reuse the same draft and run state without changing the
browser recovery contract.

## Client structure

The example should not use a request-bound `useChat` transport as the owner of
generation state. A small Bunderstack-oriented chat hook composes:

- generated query options for canonical rows;
- the standard Bunderstack realtime synchronizer;
- local display pacing for new text;
- local composer and one-message queue state;
- `sendMessage` and `stopRun` mutations.

The hook does not maintain a second authoritative message history. Its local
text buffer is only a presentation of the latest server content and can be
discarded and reconstructed at any time.

## Verification

Use a controllable responder that can pause before text, emit named steps and
tools, release text chunks on demand, and observe cancellation. Cover at least:

1. reload during text generation;
2. navigation away from and back to the conversation;
3. SSE disconnect while the job continues;
4. browser sleep beyond the Publisher replay window;
5. a late update with a lower message revision;
6. repeated submission with the same `clientMessageId`;
7. stopping during text generation;
8. stopping during a tool call;
9. `Send now` waiting for confirmed cancellation;
10. automatic submission of the one local queued message after completion;
11. expected loss of that local message on reload;
12. activity expansion before text and automatic collapse after text begins;
13. cross-process publication with Redis realtime.

The primary acceptance criterion is: closing every browser connected to a
thread has no effect on its active run, and opening a fresh browser reconstructs
all visible progress from the database before continuing to receive live
updates.

## Non-goals

- Persisting or exposing hidden model chain-of-thought.
- A generic framework-level streaming-agent API.
- A durable server-side queue of future user messages.
- Multiple simultaneous runs in one thread.
- One durable row per model token.
- Resuming a provider request from an exact token after worker failure.
