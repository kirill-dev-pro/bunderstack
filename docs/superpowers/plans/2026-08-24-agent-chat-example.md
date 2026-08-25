# Agent Chat Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runnable `examples/agent-chat` application that demonstrates a durable chat agent, auditable tools, and a scheduled background wake without introducing a framework-level agent or domain-event API.

**Architecture:** A TanStack Start application owns app-local agent tables and runtime functions. Bunderstack jobs provide durable turns and scheduled reminders; realtime keeps the chat, task list, and runtime rail current. An injected responder keeps the runtime provider-neutral, with a deterministic local implementation and an optional AI SDK OpenAI adapter.

**Tech Stack:** Bun, Bunderstack, libSQL, Better Auth anonymous sessions, TanStack Start, React, AI SDK, OpenAI provider, Zod, Valibot.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-chat-example-design.md`

## Global Constraints

- Work directly in the existing `main` checkout as requested.
- Use Bun for installation, tests, type checking, and builds.
- Keep all agent primitives app-local; do not add a public Bunderstack package or core configuration key.
- The example must run without an API key through a deterministic demo responder.
- Do not implement domain events; document the deferred seam and trade-offs.
- Every runtime behavior must be introduced by a failing test.

---

### Task 1: Durable runtime and tool journal

**Files:**

- Create: `examples/agent-chat/src/schema.ts`
- Create: `examples/agent-chat/src/agent/types.ts`
- Create: `examples/agent-chat/src/agent/runtime.ts`
- Create: `examples/agent-chat/src/agent/runtime.test.ts`
- Create: `examples/agent-chat/src/test-app.ts`

**Interfaces:**

- Produces: `getOrCreateThread(db, userId)`, `wakeAgent(ctx, threadId, reason)`, and `runAgentTurn(ctx, input, responder)`.
- Produces: `AgentResponder`, `AgentResponderInput`, and the tool methods `listTasks`, `createTask`, `completeTask`, and `scheduleReminder`.
- Persists user-visible messages, runs, and tool calls; every tool applies `userId` ownership filtering itself.

- [x] **Step 1: Write the failing runtime integration tests**

```ts
test('a turn lets the responder create a user-owned task and records the effect', async () => {
  const app = await createTestApp()
  const thread = await seedThread(app, 'user_alice')
  await seedMessage(app, thread.id, 'user_alice', 'Add book flights')

  await runAgentTurn(
    jobContext(app),
    { threadId: thread.id, reason: 'message' },
    async ({ tools }) => {
      await tools.createTask({ title: 'Book flights' })
      return { text: 'Added “Book flights”.' }
    },
  )

  expect(await app.db.select().from(tasks)).toHaveLength(1)
  expect(await app.db.select().from(agentToolCalls)).toHaveLength(1)
})
```

- [x] **Step 2: Run the focused test and observe the missing runtime failure**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL because the example runtime modules do not exist.

- [x] **Step 3: Implement the schema, test app, turn lock, context loading, tools, messages, runs, and journal**

The responder contract is:

```ts
export type AgentResponder = (
  input: AgentResponderInput,
) => Promise<{ text: string }>
```

`runAgentTurn` must acquire the thread lock, insert a running `agentRuns` row,
invoke the responder with real tool methods, insert the assistant message, mark
the run done, release the lock, and enqueue another turn when `wakeSeq` changed.

- [x] **Step 4: Run the focused test until the runtime behavior passes**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: PASS with no network calls.

### Task 2: Commitments and background wake

**Files:**

- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`

**Interfaces:**

- Consumes: the runtime and tool journal from Task 1.
- Produces: `fireCommitment(ctx, commitmentId)` and the `scheduleReminder({ title, dueAt })` tool behavior.

- [x] **Step 1: Write failing tests for scheduling and firing a reminder**

```ts
test('a scheduled reminder becomes a future job', async () => {
  await runAgentTurn(ctx, input, async ({ tools }) => {
    await tools.scheduleReminder({ title: 'Check the oven', dueAt })
    return { text: 'I will remind you.' }
  })
  expect(enqueued[0]).toEqual({ name: 'agentReminder', runAt: dueAt })
})

test('firing a commitment inserts a system message and wakes the same agent', async () => {
  await fireCommitment(ctx, commitment.id)
  expect(messages.at(-1)?.role).toBe('system')
  expect(enqueued.at(-1)?.name).toBe('agentTurn')
})
```

- [x] **Step 2: Run the focused tests and observe missing commitment behavior**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL on the reminder job and system-message assertions.

- [x] **Step 3: Implement scheduled commitment creation and idempotent firing**

The scheduler must use `ctx.jobs.enqueue('agentReminder', { commitmentId }, { runAt: dueAt })`.
`fireCommitment` must update only a pending row, publish the update, insert one
system message, and call `wakeAgent` with reason `commitment.fired`.

- [x] **Step 4: Re-run the focused tests**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: PASS.

### Task 3: Bunderstack application and model adapters

**Files:**

- Create: `examples/agent-chat/package.json`
- Create: `examples/agent-chat/tsconfig.json`
- Create: `examples/agent-chat/vite.config.ts`
- Create: `examples/agent-chat/.env.example`
- Create: `examples/agent-chat/.gitignore`
- Create: `examples/agent-chat/src/access.ts`
- Create: `examples/agent-chat/src/agent/model.ts`
- Create: `examples/agent-chat/src/agent/model.test.ts`
- Create: `examples/agent-chat/src/api.ts`
- Create: `examples/agent-chat/src/bunderstack.ts`

**Interfaces:**

- Consumes: `AgentResponder`, `wakeAgent`, `runAgentTurn`, and `fireCommitment`.
- Produces: `createDemoResponder()`, `createOpenAIResponder(options)`, `api.sendMessage`, `agentTurn`, and `agentReminder` jobs.

- [x] **Step 1: Write failing demo-responder tests**

```ts
test('demo responder turns an add request into a createTask tool call', async () => {
  const response = await createDemoResponder()({
    latestMessage: 'Add book flights',
    tools,
  })
  expect(response.text).toBe('Added “book flights”.')
  expect(createdTitles).toEqual(['book flights'])
})
```

- [x] **Step 2: Run the model test and observe the missing adapter failure**

Run: `bun test examples/agent-chat/src/agent/model.test.ts`

Expected: FAIL because `createDemoResponder` is absent.

- [x] **Step 3: Implement the deterministic responder, optional OpenAI adapter, API, access rules, and jobs**

The app selects the OpenAI adapter only when `OPENAI_API_KEY` is non-empty.
Otherwise the demo responder recognizes add/list/complete/remind requests and
returns a help response for unmatched input. API writes always derive `userId`
from `o.protected` context.

- [x] **Step 4: Install the example dependencies and run focused tests and type checking**

Run: `bun install`

Run: `bun test examples/agent-chat/src/agent`

Run: `bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: all commands exit 0.

### Task 4: Agent desk UI and documentation

**Files:**

- Create: `examples/agent-chat/src/api-client.ts`
- Create: `examples/agent-chat/src/router.tsx`
- Create: `examples/agent-chat/src/routes/__root.tsx`
- Create: `examples/agent-chat/src/routes/index.tsx`
- Create: `examples/agent-chat/src/components/LoginGate.tsx`
- Create: `examples/agent-chat/src/utils/auth-client.ts`
- Create: `examples/agent-chat/src/utils/session.ts`
- Create: `examples/agent-chat/src/styles.css`
- Create: `examples/agent-chat/README.md`
- Modify: `examples/README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: generated CRUD queries for messages, tasks, runs, tool calls, threads, and commitments plus `api.sendMessage`.
- Produces: a runnable `/` chat page and root commands `dev:agent-chat` and inclusion in `typecheck:examples`.

- [x] **Step 1: Build the authenticated chat, runtime rail, task list, and realtime subscriptions**

The page uses a two-column desktop layout and one-column mobile layout. The
composer sends one protected API mutation. Runtime rows remain read-only from
the browser. Every button has a visible focus state and the status text does
not rely on color alone.

- [x] **Step 2: Document setup, architecture, and the deferred domain-event design choice**

The README must explain the direct reminder flow in this version, show the
future `domain write -> event -> inbox -> wake` seam, and state why raw table
subscriptions and SQL triggers are deferred.

- [x] **Step 3: Generate the route tree through the normal build and verify the example**

Run: `bun run --cwd examples/agent-chat build`

Run: `bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: both commands exit 0.

### Task 5: Repository verification

**Files:**

- Review every changed file from Tasks 1–4.

**Interfaces:**

- Consumes: the complete example.
- Produces: evidence that the example integrates without changing published Bunderstack behavior.

- [x] **Step 1: Run focused example verification**

Run: `bun test examples/agent-chat/src/agent && bun run --cwd examples/agent-chat build && bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: exit 0.

- [x] **Step 2: Run workspace type checks and tests**

Run: `bun run typecheck:all`

Run: `bun test`

Expected: type checks exit 0; the test suite has no new failures beyond the recorded baseline inability of two S3 tests to bind `Bun.serve({ port: 0 })` in this environment.

- [x] **Step 3: Inspect the final diff and status**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional example, documentation,
workspace manifest, and lockfile changes.
