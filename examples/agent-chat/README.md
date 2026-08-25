# Agent Chat

A deliberately small, app-local experiment in building a durable agent on
Bunderstack. The user talks to one long-lived agent that can manage their task
list and schedule a reminder that wakes the agent later.

The example is an incubation space, not a proposed public Bunderstack API. Its
purpose is to make the recurring primitives visible before deciding which of
them deserve to become a library.

## Run it

From the repository root:

```bash
bun install
cp examples/agent-chat/.env.example examples/agent-chat/.env
```

Run the example:

```bash
bun run dev:agent-chat
```

The development server embeds a queue worker so job publications and SSE use
the same in-memory realtime transport. Open <http://localhost:3007>. The default
responder is deterministic and needs
no API key. It understands:

- `Add book flights`
- `List tasks`
- `Complete book flights`
- `Remind me in 5 minutes to stretch`

Set `AI_API_KEY` (and optionally `AI_BASE_URL` and `AI_MODEL`) to use an AI provider.
By default it is preconfigured for Hetzner Experiments AI (`Qwen3.8-27B` at `https://inference.hetzner.com/api/v1`).
You can also point `AI_BASE_URL` to DeepSeek (`https://api.deepseek.com`, model `deepseek-chat`) or set `OPENAI_API_KEY` for standard OpenAI.
The runtime itself does not import or depend on a provider.

## What the example is testing

The implementation separates five concerns that are easy to accidentally mix
together in a first agent:

1. **Inbox** — user and system messages are durable rows.
2. **Wake** — every reason to run increments `wakeSeq` and enqueues one deduped
   `agentTurn` job.
3. **Turn** — a per-thread lock prevents concurrent turns and re-enqueues when a
   wake arrives while the agent is running.
4. **Tools** — every tool checks `userId` itself, performs one domain action,
   and writes an auditable journal entry.
5. **Commitments** — a reminder is durable application state plus a scheduled
   job, not an in-memory timer owned by the model call.

The browser can read only rows scoped to its authenticated user. It cannot call
generated CRUD mutations for tasks, messages, runs, tool calls, or commitments;
the protected `sendMessage` procedure and server-side tools are the write paths.

```text
browser message
      │
      ▼
agent_messages ──► wakeSeq + agentTurn job
                         │
                         ▼
                load context + call tools
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      task/domain write       agent_tool_calls
             │
             ▼
      assistant message
```

The runtime rail in the UI intentionally exposes runs, tool calls, commitments,
and wake state. They are part of the product contract for an inspectable agent,
not debugging data hidden behind logs.

## Design choice: domain events are deferred

This version does **not** implement a generic domain-event API, subscribe to raw
table changes, or install SQL triggers. A scheduled reminder follows the direct
flow:

```text
agentReminder job
  → mark commitment fired (idempotently)
  → insert “Reminder due” system message
  → wake the agent
```

That direct path is enough to test the core agent loop without prematurely
choosing an event envelope, delivery guarantee, retention policy, or subscription
language for Bunderstack.

The seam is intentional. If another part of the product later changes something
the agent cares about — for example a saved search finds a new property — the
same example could evolve to:

```text
domain write
  → durable domain event (`search.match_found`)
  → matching agent inbox/subscription
  → system message or structured inbox item
  → wake(agent)
```

That would simplify this example once there are several independent wake
sources: the search job, profile update, billing change, and reminder scheduler
would publish semantic facts rather than each knowing how to construct an agent
message and enqueue a turn. It would also give retries and auditing one shared
boundary.

Raw table subscriptions are deliberately not that boundary. A row update says
what storage changed, not what happened in the business. SQL triggers have the
same semantic problem and make authorization, versioning, testing, and external
side effects harder to see in application code. The likely future primitive is
therefore an explicit, durable domain event emitted by a successful command —
but this example should earn that abstraction through real use cases first.

## What is intentionally missing

- a framework-level `agent` config key or `@bunderstack/agent` package;
- automatic CRUD-to-tool generation;
- arbitrary database access for the model;
- multi-agent delegation, vector memory, approval workflows, or token streaming;
- generic domain events or subscriptions.

Those may become useful, but none is required to validate the lower-level
primitives in this example.

For a multi-process deployment, configure Redis realtime and run the worker as
a separate process instead of calling `app.startWorker()` in the web process.
