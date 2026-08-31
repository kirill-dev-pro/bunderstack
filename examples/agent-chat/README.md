# Agent Chat

A deliberately small, app-local experiment in building a durable, declarative personal agent on Bunderstack. The user talks to one long-lived agent that manages their task list, remembers facts and preferences, executes durable scheduled commitments (notifications, exact tool calls, and autonomous objectives), and requests explicit user approval for destructive actions.

The example is an incubation space, not a proposed public Bunderstack API. Its purpose is to explore and validate recurring agent primitives before deciding which abstractions deserve to become framework features.

## Quick Start

From the repository root:

```bash
bun install
cp examples/agent-chat/.env.example examples/agent-chat/.env
```

Run the example:

```bash
bun run dev:agent-chat
```

The development server embeds a queue worker so job publications and SSE use the same in-memory realtime transport. Open <http://localhost:3007>.

### Anonymous-first Entry and Account Upgrade

1. **One-Click Anonymous Entry**: Click **Continue anonymously** to start immediately. A friendly name (such as `Gentle Otter`) is assigned automatically via Better Auth.
2. **Save Your Agent**: At any point, an anonymous user can enter an email and password in the **Save your agent** panel. This links the account and transactionally transfers all threads, messages, runs, tool calls, tasks, commitments, memory, inbox items, requests, and tool grants to the permanent account without loss of history.

### Model Responders

The default responder is deterministic and needs no API key. It understands:

- `Add book flights`
- `List tasks`
- `Complete book flights`
- `Delete book flights` _(triggers approval workflow)_
- `Remember that I prefer morning flights`
- `Remind me in 5 minutes to stretch`

To use an AI provider, choose it with `AI_PROVIDER`:

- `AI_PROVIDER=openai` keeps the existing OpenAI-compatible adapter. Set
  `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for Hetzner Experiments AI or
  DeepSeek. Standard OpenAI can use `OPENAI_API_KEY` and `OPENAI_MODEL`.
- `AI_PROVIDER=iqdoc` selects IQdoc as an upstream medical agent. Set
  `IQDOC_API_KEY`, `IQDOC_BASE_URL`, and optionally `IQDOC_MODEL` (default
  `assistant_auto`). IQdoc authenticates with `X-Api-Key`; the adapter sends
  stable UUID-shaped chat and message correlation headers decoded from the
  Bunderstack thread and run TypeIDs.

Supported IQdoc model IDs are `assistant_auto`, `pubmed_assistant_fast`,
`clinrec_assistant_fast`, `standart_assistant_fast`, `esmo_assistant_fast`,
`asa_assistant_fast`, `far_assistant_fast`, and `assistant_pro`.

IQdoc remains the upstream agent: it owns medical retrieval, calculators, and
its other provider-side actions. The example does not pass its local task,
memory, commitment, or approval tools to IQdoc. IQdoc `status` events become
visible durable activity steps, calculator results become visible durable tool
steps, and ordinary text uses the same revisioned assistant draft as every
other provider.

The runtime itself does not import or depend on a specific provider; it compiles AI SDK tool schemas dynamically from the local agent declaration.

## Architecture and Primitives

The implementation separates core concerns into explicit, app-local boundaries:

### 1. App-Local Declarations (`src/agent/declaration.ts`, `src/agent/definition.ts`)

- Tools are declared server-side with `defineTool({ id, version, inputSchema, approval, execute })`.
- Policies and schemas are declared once. The AI SDK adapter builds tool specifications directly from `agentDefinition`.
- The execution context (`userId`, `threadId`, `runId`, `trigger`) is injected server-side by the runtime; the model never chooses or supplies `userId`.

### 2. Bounded Turn Context (`src/agent/context.ts`)

- Context size is strictly bounded: the most recent 20 conversation messages, up to 8 trusted memory items, up to 10 aggregated inbox events, and active domain tasks.
- Prompt injection and context overflow risks are mitigated by enforcing hard limits and presenting long-term memory and inbox events as clearly delimited data.
- The model receives a compact tool operating contract: tools are its only application interface, ID-based mutations first discover IDs with `listTasks`, pending approvals stop the model loop, and completion may be claimed only after a successful tool result.

### 3. Trusted Long-Term Memory (`src/agent/memory.ts`)

- Stored in the durable `agentMemory` table with unique `(userId, key)` semantics.
- Only trusted sources (`user`, `system`, `derived`) can write or update memory rows.
- The UI provides a **Memory Panel** where users can inspect, edit, or delete stored facts and preferences.

### 4. Durable Commitments & Execution Specs (`src/agent/commitments.ts`)

- `agentCommitments` stores durable future intentions with explicit execution specifications:
  - `notify`: Delivers a user-facing assistant message when due.
  - `tool_call`: Executes a validated, schedulable tool call (`createTask`, `completeTask`, `remember`, `deleteTask`) deterministically without model reinterpretation at wake time.
  - `objective`: Launches an autonomous model turn with a trusted execution envelope (`trigger: 'commitment'`) and structured terminal outcomes.
- **Schedules & Recurrence**: Commitments can be one-shot (with `dueAt`) or recurring (with `schedule: { kind: 'cron', expr }` or `{ kind: 'interval', everySeconds }`). Recurring commitments automatically compute their next trigger time and re-enqueue future runs.
- **Tools**: The agent manages commitments via `createCommitment`, `listCommitments`, `cancelCommitment`, `pauseCommitment`, `resumeCommitment`, and `retryCommitment`.
- **Approvals & Independence**: If a scheduled tool call requires user approval, the commitment transitions to `waiting_for_approval` and releases its worker/thread lock. Other independent commitments remain runnable. Resolving the approval resumes the exact commitment run.
- **Explicit Terminal States**: Commitments transition through `pending`, `blocked`, `running`, `waiting_for_approval`, `paused`, `completed`, `failed`, and `cancelled`. Completion requires verifiable tool execution evidence, not assistant prose.

### 5. Policy Engine, Approvals, and Persistent Grants (`src/agent/policy.ts`, `src/agent/approvals.ts`)

- Destructive tools (such as `deleteTask`) require explicit user approval (`{ mode: 'required', remember: true }`).
- When invoked without a grant, AI SDK emits a `tool-approval-request`. The runtime validates and freezes the exact call, stores the accumulated model-message checkpoint, marks the existing run `waiting_for_approval`, and releases its worker/thread lock. It does not create a final assistant reply.
- The **Approvals & Grants** UI allows users to:
  - **Allow now** (`allow_once`): Queues one exact capability for the frozen call and resumes its existing `runId`.
  - **Always allow** (`always_allow`): Creates a persistent, revocable grant and resumes the existing run.
  - **Reject**: Resumes the same run with a denied approval response and no tool execution.
  - **Revoke**: Immediately revokes an active grant.
- Resume is a new durable worker/model invocation but not a new logical turn. The saved AI SDK transcript receives the matching `tool-approval-response`, executes the frozen tool at most once, and continues the remaining plan. If another protected tool is needed, the same run can suspend and resume again.

### 6. Durable Streaming and Recovery (`src/agent/run-recorder.ts`, `src/hooks/useAgentChat.ts`)

Message submission and message observation are deliberately separate. `sendMessage` is an idempotent command: it atomically stores the user message, a queued run, and an empty server-owned assistant draft, then returns `202`. It never owns the provider response stream. The browser observes canonical `agentMessages`, `agentRuns`, and `agentRunSteps` rows through ordinary Bunderstack queries and realtime updates.

The worker consumes the AI provider stream and persists the complete assistant draft immediately on the first delta, at most once per 150 ms while text is flowing, and once more at completion. Every snapshot has a monotonically increasing `revision`; the client rejects late lower revisions and only animates toward accepted snapshots. Consequently:

- Reloading, changing routes, reconnecting after a network interruption, or waking a sleeping mobile tab reconstructs the latest full draft with a normal refetch and then resumes live observation.
- Replaying a message command with the same `clientMessageId` returns the same message and run instead of duplicating the turn.
- Observable status, retrieval, and tool-call steps are durable ledger rows. This demo shows every visible tool input and output, but private chain-of-thought is neither requested nor stored; a production application can mark selected steps `hidden`.
- The activity ledger stays open before answer text begins, collapses when the answer starts, and remains available for later inspection.

**Stop** is also a durable command. A queued or waiting run is cancelled immediately; a running worker observes `cancelling`, aborts its single provider request, preserves partial text, and publishes the terminal `cancelled` state. Closing the browser is not Stop and does not cancel server work.

While a run is active, the composer may hold one intentionally ephemeral message in React state. **Send now** requests Stop but still waits for a confirmed terminal run before accepting that message. A normal queued message waits for completion. This one-message queue is never written to local or session storage, so reloading the tab intentionally discards it.

The recovery guarantee in this experiment covers loss of the connection between the browser and this application while the worker and provider request remain healthy. Restarting a failed worker attempt or continuing a disconnected provider stream from an exact token is outside the current scope.

### 7. Security and Data Scoping

- Browser clients are restricted to read-only generated CRUD queries scoped strictly to the authenticated `userId`.
- Direct table mutations from the browser are denied. State changes (sending messages, editing memory, resolving approvals, revoking grants) occur via thin protected RPC procedures in `src/api.ts`.
- The model never receives raw database access or arbitrary authority.

```text
 browser (commands + read-only live queries)
                   │                         ▲
                   ▼                         │ durable snapshots / refetch
 agent_messages / agent_runs ─────► agentTurn job
                                           │
                                           ▼
                                 assemble bounded context
                                           │
                                           ▼
                              provider stream + policy
                                ┌──────────┴──────────┐
                     allow / grant                approval required
                           │                              │
                           ▼                              ▼
                    execute tool                 create agent_requests
                           │                              │
                           ▼                              ▼
                 agent_tool_calls +             user resolves via UI
                 domain state updates           (allow_once / always_allow)
                                                          │
                                                          ▼
                                             resume same run checkpoint
```

## Explicit Non-Goals

To keep the experiment focused, this example deliberately does **not** include:

- A public framework-level `agent` config key or `@bunderstack/agent` package export.
- Spaces, organizations, memberships, or multi-agent delegation.
- Raw SQL access or automatic CRUD-to-tool generation for the model.
- Vector databases or semantic retrieval pipelines.
- Worker-attempt recovery or exact-token continuation after the AI provider connection itself fails.

## Deployment Notes

For multi-process or production deployments:

- Configure Redis realtime for cross-process SSE event fan-out. It is required when the web process and queue worker are separate; the database remains canonical, while Redis carries live invalidations between processes.
- Run queue workers in dedicated worker processes (`bun run --cwd examples/agent-chat worker`) instead of embedding the worker in the web server process.
