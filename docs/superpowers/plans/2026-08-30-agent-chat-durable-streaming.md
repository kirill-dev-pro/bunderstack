# Agent Chat Durable Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream durable agent activity and answer snapshots through Bunderstack realtime so a browser can disconnect, reload, or change chats without affecting the server-owned turn.

**Architecture:** `sendMessage` becomes an idempotent command that creates a user message, run, and empty assistant draft before enqueueing a Bunderstack job. The worker consumes the AI SDK stream, periodically persists canonical message snapshots and observable run steps, and publishes those rows through the existing realtime facade; the browser renders database state and uses local state only for animation and one optional queued input.

**Tech Stack:** Bun, TypeScript, Bunderstack jobs and realtime, Drizzle/libSQL, AI SDK 7 `streamText`, TanStack Query, React 19, CSS.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-chat-durable-streaming-design.md`

## Global Constraints

- Work directly in the existing `main` checkout as requested; do not create a worktree.
- Use Bun for installation, tests, type checking, migrations, and builds.
- Keep the implementation app-local under `examples/agent-chat`; do not add a public Bunderstack agent API.
- Treat the database as the source of truth and realtime as a notification path.
- A browser disconnect, route change, or suspended mobile tab must never cancel the job.
- Do not persist or expose hidden model chain-of-thought; persist only explicit display summaries, tool calls, retrieval actions, and statuses.
- The technical demo shows every tool step, including exact tool name, version, arguments, result, duration, and status.
- Persist answer snapshots at a target cadence of 150 ms, not one row per token.
- Keep at most one queued future message in React state; losing it on reload is intentional.
- Preserve the existing anonymous-account transfer, approval resume, commitment execution, tool idempotency, and user scoping behavior.
- Introduce every behavior through a failing test and commit after each task is green.
- Preserve the existing visual identity: `DM Sans`, `IBM Plex Mono`, `#07100f`, `#0d1816`, `#b8f55d`, `#61d6ca`, and the current square technical panels. The signature addition is an in-message activity ledger, not a page-wide redesign.

---

### Task 1: Durable message, run, and activity-step schema

**Files:**

- Modify: `examples/agent-chat/src/schema.ts`
- Modify: `examples/agent-chat/src/access.ts`
- Modify: `examples/agent-chat/src/agent/schema.test.ts`
- Modify: `examples/agent-chat/src/agent/auth-transfer.ts`
- Modify: `examples/agent-chat/src/agent/auth-transfer.test.ts`
- Modify: `examples/agent-chat/src/agent/commitments.ts`
- Modify: `examples/agent-chat/src/agent/commitments.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Create: the next generated SQL migration and snapshot under `examples/agent-chat/migrations/`

**Interfaces:**

- Produces: `AgentMessageStatus`, `AgentRunStatus`, `AgentRunStepKind`, `AgentRunStepStatus`, and `AgentRunStepVisibility` schema literals.
- Produces: `agentRunSteps`, readable only through an authenticated user-scoped generated API.
- Produces: unique `(threadId, clientMessageId)` message identity and linked `inputMessageId`/`assistantMessageId` run fields.
- Produces: a partial unique index allowing at most one active run per thread.
- Preserves: `waiting_for_approval` and all commitment-run relationships.

- [ ] **Step 1: Write failing schema and account-transfer tests**

Add imports for `agentMessages` and `agentRunSteps`, then add this test to
`agent/schema.test.ts`:

```ts
test('stores a revisioned assistant draft and visible run steps', async () => {
  testApp = await createTestApp()
  const userId = await testApp.seedUser('Streaming Lynx')
  const threadId = generateTypeId('athread')
  const inputMessageId = generateTypeId('amsg')
  const runId = generateTypeId('arun')
  const assistantMessageId = generateTypeId('amsg')

  await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })
  await testApp.ctx.db.insert(agentMessages).values({
    id: inputMessageId,
    threadId,
    userId,
    role: 'user',
    content: 'List tasks',
    clientMessageId: 'browser-message-1',
  })
  await testApp.ctx.db.insert(agentRuns).values({
    id: runId,
    threadId,
    userId,
    inputMessageId,
    assistantMessageId,
    reason: 'message',
    status: 'queued',
  })
  await testApp.ctx.db.insert(agentMessages).values({
    id: assistantMessageId,
    threadId,
    userId,
    runId,
    role: 'assistant',
    content: 'Three',
    status: 'streaming',
    revision: 2,
  })
  await testApp.ctx.db.insert(agentRunSteps).values({
    runId,
    threadId,
    userId,
    sequence: 1,
    kind: 'tool_call',
    title: 'listTasks v1',
    status: 'complete',
    visibility: 'visible',
    input: {},
    output: [{ id: 'task_1' }],
  })

  expect(await testApp.ctx.db.select().from(agentMessages).all()).toMatchObject([
    { id: inputMessageId, clientMessageId: 'browser-message-1' },
    {
      id: assistantMessageId,
      runId,
      status: 'streaming',
      revision: 2,
    },
  ])
  expect(await testApp.ctx.db.select().from(agentRunSteps).get()).toMatchObject({
    runId,
    sequence: 1,
    kind: 'tool_call',
    status: 'complete',
    input: {},
  })
})
```

Extend the account-transfer fixture with one `agentRunSteps` row and include
the table in `ownedTables`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/agent/schema.test.ts examples/agent-chat/src/agent/auth-transfer.test.ts
```

Expected: FAIL because the new columns and `agentRunSteps` do not exist.

- [ ] **Step 3: Add the schema and normalize run terminal names**

Define the shared statuses immediately above the tables:

```ts
export const agentMessageStatuses = [
  'queued',
  'streaming',
  'complete',
  'cancelled',
  'error',
] as const

export const agentRunStatuses = [
  'queued',
  'running',
  'waiting_for_approval',
  'cancelling',
  'cancelled',
  'complete',
  'error',
] as const
```

Add nullable `clientMessageId` and `runId`, non-null defaulted `status`,
`revision`, and `updatedAt` to `agentMessages`. Add a unique index on
`(threadId, clientMessageId)`. Add nullable `inputMessageId` and
`assistantMessageId` to `agentRuns`. Use plain typed ID columns for the circular
message/run links and keep the thread/user foreign keys as the ownership
boundary. Convert `agentRuns` to the callback form and add a partial unique
index on `threadId` for statuses `queued`, `running`,
`waiting_for_approval`, and `cancelling`; terminal rows do not occupy the
slot. This database constraint is the final arbiter when two tabs accept
different messages concurrently.

Create `agentRunSteps` with this shape:

```ts
export const agentRunSteps = sqliteTable(
  'agent_run_steps',
  {
    id: typeid('astep')
      .primaryKey()
      .$defaultFn(() => generateTypeId('astep')),
    runId: typeid('arun').notNull(),
    threadId: typeid('athread')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    kind: text('kind', {
      enum: ['status', 'reasoning_summary', 'tool_call', 'retrieval'],
    }).notNull(),
    title: text('title').notNull(),
    detail: text('detail', { mode: 'json' }).$type<unknown>(),
    status: text('status', {
      enum: ['running', 'complete', 'failed', 'cancelled'],
    }).notNull(),
    visibility: text('visibility', {
      enum: ['visible', 'hidden'],
    })
      .notNull()
      .default('visible'),
    input: text('input', { mode: 'json' }).$type<unknown>(),
    output: text('output', { mode: 'json' }).$type<unknown>(),
    toolCallId: typeid('acall'),
    startedAt: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('agent_run_steps_run_sequence_unique').on(
      table.runId,
      table.sequence,
    ),
  ],
)
```

Change only `agentRuns` terminal literals from `done`/`failed` to
`complete`/`error` throughout runtime, commitments, and their tests.
`agentToolCalls.status` remains `running | done | failed`, and commitment
statuses remain unchanged.

- [ ] **Step 4: Add access and anonymous-transfer coverage**

Add `agentRunSteps` to `access.ts` with `agentOwnedReadOnly`, filters for
`threadId`, `runId`, and `visibility`, and ascending `sequence` sort. Update
`transferAnonymousAgentData` to change `userId` on steps before changing the
thread owner.

- [ ] **Step 5: Generate the migration and verify GREEN**

Run:

```bash
bun run --cwd examples/agent-chat db:generate
bun test examples/agent-chat/src/agent/schema.test.ts examples/agent-chat/src/agent/auth-transfer.test.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/commitments.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: migration generation succeeds; all focused tests and type checking
exit 0.

- [ ] **Step 6: Commit the schema slice**

```bash
git add examples/agent-chat/src/schema.ts examples/agent-chat/src/access.ts examples/agent-chat/src/agent/schema.test.ts examples/agent-chat/src/agent/auth-transfer.ts examples/agent-chat/src/agent/auth-transfer.test.ts examples/agent-chat/src/agent/commitments.ts examples/agent-chat/src/agent/commitments.test.ts examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/migrations
git commit -m "feat(agent-chat): add durable streaming state"
```

---

### Task 2: Idempotent message acceptance and reserved draft

**Files:**

- Create: `examples/agent-chat/src/agent/messages.ts`
- Create: `examples/agent-chat/src/agent/messages.test.ts`
- Modify: `examples/agent-chat/src/api.ts`
- Modify: `examples/agent-chat/src/api.test.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/src/test-app.ts`

**Interfaces:**

- Produces: `acceptUserMessage(ctx, { userId, content, clientMessageId })`.
- Returns: `{ messageId, threadId, runId, assistantMessageId }`.
- Enqueues: `agentTurn` with `{ threadId, reason: 'message', runId, executionKey: runId }` and dedupe key `agent-run:${runId}`.
- Guarantees: retrying the same `(threadId, clientMessageId)` returns and re-enqueues the same run without duplicating rows.

- [ ] **Step 1: Write failing acceptance tests**

Create `agent/messages.test.ts` with these assertions:

```ts
test('accepts one message with a queued run and reserved assistant draft', async () => {
  const app = await setup()
  const accepted = await acceptUserMessage(app.ctx, {
    userId: app.userId,
    content: 'List tasks',
    clientMessageId: 'browser-1',
  })

  expect(await app.ctx.db.select().from(agentMessages).all()).toMatchObject([
    { id: accepted.messageId, role: 'user', status: 'complete' },
    {
      id: accepted.assistantMessageId,
      role: 'assistant',
      runId: accepted.runId,
      content: '',
      status: 'queued',
      revision: 0,
    },
  ])
  expect(await app.ctx.db.select().from(agentRuns).get()).toMatchObject({
    id: accepted.runId,
    inputMessageId: accepted.messageId,
    assistantMessageId: accepted.assistantMessageId,
    status: 'queued',
  })
  expect(app.enqueued.at(-1)).toMatchObject({
    name: 'agentTurn',
    input: { runId: accepted.runId, executionKey: accepted.runId },
    options: { dedupeKey: `agent-run:${accepted.runId}` },
  })
})

test('reuses the same accepted run for a repeated client message id', async () => {
  const app = await setup()
  const input = {
    userId: app.userId,
    content: 'List tasks',
    clientMessageId: 'browser-1',
  }
  const first = await acceptUserMessage(app.ctx, input)
  const second = await acceptUserMessage(app.ctx, input)

  expect(second).toEqual(first)
  expect(await app.ctx.db.select().from(agentMessages).all()).toHaveLength(2)
  expect(await app.ctx.db.select().from(agentRuns).all()).toHaveLength(1)
})

test('accepts only one of two different messages racing for the active slot', async () => {
  const app = await setup()
  const results = await Promise.allSettled([
    acceptUserMessage(app.ctx, {
      userId: app.userId,
      content: 'First',
      clientMessageId: 'browser-1',
    }),
    acceptUserMessage(app.ctx, {
      userId: app.userId,
      content: 'Second',
      clientMessageId: 'browser-2',
    }),
  ])

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(await app.ctx.db.select().from(agentMessages).all()).toHaveLength(2)
  expect(await app.ctx.db.select().from(agentRuns).all()).toHaveLength(1)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test examples/agent-chat/src/agent/messages.test.ts`

Expected: FAIL because `acceptUserMessage` does not exist.

- [ ] **Step 3: Implement acceptance with pre-generated IDs**

Use `generateTypeId` before the transaction so both circular links are stable:

```ts
const messageId = generateTypeId('amsg')
const runId = generateTypeId('arun')
const assistantMessageId = generateTypeId('amsg')

await ctx.db.transaction(async (tx: any) => {
  await tx.insert(agentMessages).values({
    id: messageId,
    threadId: thread.id,
    userId: input.userId,
    role: 'user',
    content: input.content,
    clientMessageId: input.clientMessageId,
    status: 'complete',
  })
  await tx.insert(agentRuns).values({
    id: runId,
    threadId: thread.id,
    userId: input.userId,
    inputMessageId: messageId,
    assistantMessageId,
    reason: 'message',
    status: 'queued',
  })
  await tx.insert(agentMessages).values({
    id: assistantMessageId,
    threadId: thread.id,
    userId: input.userId,
    runId,
    role: 'assistant',
    content: '',
    status: 'queued',
  })
})
```

Before inserting, query the existing user message by thread and
`clientMessageId`; recover its run through `inputMessageId`. Also catch a
unique-constraint race and perform the same lookup. Enqueue after either the
new or existing path so a retry repairs an acknowledgement lost between commit
and enqueue. Before creating a new acceptance, reject the request when the
thread already has a run in `queued`, `running`, `waiting_for_approval`, or
`cancelling`; the product's only pending-message queue remains browser-local.
If the insert still loses the partial-index race, retry the idempotency lookup;
when it is not the same client message, throw the same typed active-run error.
After a genuinely new commit, publish the returned user message, run, and
assistant draft as `create` events. Do not publish duplicate creates from the
idempotent lookup path.

- [ ] **Step 4: Replace the API handler contract**

Require both fields:

```ts
.input(type({
  content: '1 <= string <= 4000',
  clientMessageId: '1 <= string <= 128',
}))
.output(type({
  messageId: 'string',
  threadId: 'string',
  runId: 'string',
  assistantMessageId: 'string',
}))
```

The handler calls `acceptUserMessage` and no longer inserts/publishes/wakes
inline. Configure the route with `successStatus: 202`, and map the active-run
rejection to a conflict response so a racing browser can retain the message
locally. Extend the job input declarations in `bunderstack.ts` and
`test-app.ts` with optional `executionKey` if it is not already accepted by the
fixture.

- [ ] **Step 5: Add authenticated HTTP idempotency coverage and verify GREEN**

In `api.test.ts`, authenticate Alice, POST the same body twice, assert both
responses are 202 and JSON-equal, then assert two messages and one run exist.
POST a different `clientMessageId` while that run is active and assert a
conflict response with no additional messages or runs.

Run:

```bash
bun test examples/agent-chat/src/agent/messages.test.ts examples/agent-chat/src/api.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: PASS and exit 0.

- [ ] **Step 6: Commit the acceptance slice**

```bash
git add examples/agent-chat/src/agent/messages.ts examples/agent-chat/src/agent/messages.test.ts examples/agent-chat/src/api.ts examples/agent-chat/src/api.test.ts examples/agent-chat/src/bunderstack.ts examples/agent-chat/src/test-app.ts
git commit -m "feat(agent-chat): accept durable message runs"
```

---

### Task 3: Throttled answer snapshots and observable step recorder

**Files:**

- Create: `examples/agent-chat/src/agent/run-recorder.ts`
- Create: `examples/agent-chat/src/agent/run-recorder.test.ts`

**Interfaces:**

- Produces: `createRunRecorder(ctx, run, options?)`.
- Produces methods: `appendText(delta)`, `replaceText(text)`, `flush()`, `startStep(input)`, `finishStep(id, output)`, `failStep(id, error)`, and `finishMessage(status)`.
- Uses: `options.flushMs` default `150`, plus injectable `options.now`,
  `options.schedule`, and `options.cancelScheduled` for deterministic tests.
- Guarantees: every published row is the canonical row returned by Drizzle; every message update increments `revision`.

- [ ] **Step 1: Write failing recorder tests**

Use a fake clock and capture publications by wrapping `ctx.realtime.publish`:

```ts
test('persists throttled snapshots and forces the final remainder', async () => {
  let now = 1_000
  let scheduled: (() => Promise<void>) | undefined
  const { ctx, run, assistantMessage, published } = await setupRecorder()
  const recorder = await createRunRecorder(ctx, run, {
    flushMs: 150,
    now: () => now,
    schedule: (callback) => {
      scheduled = callback
      return 1
    },
    cancelScheduled: () => {
      scheduled = undefined
    },
  })

  await recorder.appendText('Hello')
  now += 50
  await recorder.appendText(' world')
  expect(await readMessage(ctx, assistantMessage.id)).toMatchObject({
    content: 'Hello',
    revision: 1,
    status: 'streaming',
  })

  now += 100
  await scheduled?.()
  expect(await readMessage(ctx, assistantMessage.id)).toMatchObject({
    content: 'Hello world',
    revision: 2,
  })
  expect(published.filter((item) => item.table === 'agentMessages')).toHaveLength(2)

  await recorder.appendText('!')
  await recorder.flush()
  expect(await readMessage(ctx, assistantMessage.id)).toMatchObject({
    content: 'Hello world!',
    revision: 3,
  })
})

test('records an ordered visible tool step with exact input and output', async () => {
  const { ctx, run } = await setupRecorder()
  const recorder = await createRunRecorder(ctx, run)
  const step = await recorder.startStep({
    kind: 'tool_call',
    title: 'listTasks v1',
    input: {},
    visibility: 'visible',
  })
  await recorder.finishStep(step.id, [{ id: 'task_1' }])

  expect(await ctx.db.select().from(agentRunSteps).all()).toMatchObject([
    {
      sequence: 1,
      kind: 'tool_call',
      status: 'complete',
      input: {},
      output: [{ id: 'task_1' }],
    },
  ])
})
```

- [ ] **Step 2: Run the recorder test and verify RED**

Run: `bun test examples/agent-chat/src/agent/run-recorder.test.ts`

Expected: FAIL because the recorder module is absent.

- [ ] **Step 3: Implement the recorder**

Keep one in-memory `content`, `persistedContent`, `lastFlushAt`,
`scheduledFlush`, a serialized async write chain, and `nextSequence`.
`appendText` flushes immediately for the first delta and whenever
`now() - lastFlushAt >= flushMs`; otherwise it schedules one trailing flush for
the remaining interval without resetting that deadline for every token.
`flush()` cancels the pending timer, awaits the write chain, and always persists
a changed remainder. Use an atomic revision expression:

```ts
const [message] = await ctx.db
  .update(agentMessages)
  .set({
    content,
    status: 'streaming',
    revision: sql`${agentMessages.revision} + 1`,
    updatedAt: new Date(),
  })
  .where(eq(agentMessages.id, run.assistantMessageId))
  .returning()
await ctx.realtime.publish(agentMessages, 'update', message)
```

Initialize `nextSequence` from the largest existing step sequence so approval
resume continues the same ledger. Publish step creation as `create` and
terminal step changes as `update`.

- [ ] **Step 4: Verify recorder tests and type checking**

Run:

```bash
bun test examples/agent-chat/src/agent/run-recorder.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the recorder slice**

```bash
git add examples/agent-chat/src/agent/run-recorder.ts examples/agent-chat/src/agent/run-recorder.test.ts
git commit -m "feat(agent-chat): persist streamed run progress"
```

---

### Task 4: Provider-neutral streaming responder contract

**Files:**

- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/agent/model.ts`
- Modify: `examples/agent-chat/src/agent/model.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/commitments.ts`

**Interfaces:**

- Produces: `AgentResponderStream` on `AgentResponderInput` and
  `createNoopAgentStream()` for execution paths that do not yet expose live
  progress.
- `AgentResponderStream`: `{ signal, writeTextDelta(delta), writeStatus(title) }`.
- Changes: `createLanguageModelResponder` uses AI SDK `streamText`, awaits its stream independently of any HTTP response, and retains the existing approval checkpoint result union.
- Preserves: deterministic `createDemoResponder` and no-key startup.

- [ ] **Step 1: Add a failing model-stream test**

Import `simulateReadableStream` from `ai/test` and construct a V4 stream:

```ts
test('forwards model text deltas to the durable stream observer', async () => {
  const writeTextDelta = mock(async (_delta: string) => {})
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Hello' },
          { type: 'text-delta', id: 'text-1', delta: ' world' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ],
      }),
    },
  })
  const { value } = input('Hello', {
    stream: {
      signal: new AbortController().signal,
      writeTextDelta,
      writeStatus: async () => {},
    },
  })

  const result = await createLanguageModelResponder(model)(value)

  expect(writeTextDelta).toHaveBeenNthCalledWith(1, 'Hello')
  expect(writeTextDelta).toHaveBeenNthCalledWith(2, ' world')
  expect(textOf(result)).toBe('Hello world')
})
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `bun test examples/agent-chat/src/agent/model.test.ts`

Expected: FAIL because the responder input has no stream observer and the
adapter still uses `generateText`.

- [ ] **Step 3: Add the observer and change the AI adapter to `streamText`**

Add:

```ts
export interface AgentResponderStream {
  signal: AbortSignal
  writeTextDelta(delta: string): Promise<void>
  writeStatus(title: string): Promise<void>
}

export function createNoopAgentStream(): AgentResponderStream {
  return {
    signal: new AbortController().signal,
    writeTextDelta: async () => {},
    writeStatus: async () => {},
  }
}
```

`AgentResponderInput.stream` is required at runtime; the model-test `input()`
factory supplies no-op defaults. Add `stream: createNoopAgentStream()` to the
existing responder calls in `runAgentTurn` and commitment objective execution;
Task 5 replaces the chat-turn no-op with the durable recorder. In
`createLanguageModelResponder`, call:

```ts
const result = streamText({
  model,
  system,
  messages,
  tools: createModelTools(input),
  maxRetries: 3,
  stopWhen: stepCountIs(6),
  abortSignal: input.stream.signal,
})

for await (const chunk of result.stream) {
  if (chunk.type === 'text-delta') {
    await input.stream.writeTextDelta(chunk.text)
  }
}
```

Then build the checkpoint from `await result.responseMessages`, inspect
`await result.content` for a non-automatic `tool-approval-request`, and return
`await result.text` for the completed result. Do not write reasoning deltas;
only explicit `writeStatus` calls are user-visible.

The deterministic responder keeps returning completed text. Runtime will use
the final text as a fallback when the responder emitted no deltas.

- [ ] **Step 4: Re-run all model tests and type checking**

Run:

```bash
bun test examples/agent-chat/src/agent/model.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: all existing approval tests and the new streaming test pass.

- [ ] **Step 5: Commit the responder slice**

```bash
git add examples/agent-chat/src/agent/types.ts examples/agent-chat/src/agent/model.ts examples/agent-chat/src/agent/model.test.ts examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/agent/commitments.ts
git commit -m "feat(agent-chat): stream provider responses"
```

---

### Task 5: Streamed runtime lifecycle and tool activity

**Files:**

- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/run-recorder.ts`
- Modify: `examples/agent-chat/src/agent/approvals.ts`

**Interfaces:**

- Consumes: accepted queued runs, `AgentResponderStream`, and `createRunRecorder`.
- Produces: the same `runAgentTurn` public function, now updating one reserved draft throughout a turn.
- Produces: visible tool steps around every invocation, linked to the final `agentToolCalls` row when available.
- Preserves: same-run approval resume and exactly-once tool execution identities.

- [ ] **Step 1: Add failing runtime streaming and tool-step tests**

Add a test that starts from `acceptUserMessage`, then emits controlled deltas:

```ts
test('streams into the reserved draft and completes the same message', async () => {
  const state = await setup()
  const accepted = await acceptUserMessage(state.ctx, {
    userId: state.userId,
    content: 'List tasks',
    clientMessageId: 'browser-1',
  })

  await runAgentTurn(
    state.ctx,
    {
      threadId: state.thread.id,
      reason: 'message',
      runId: accepted.runId,
      executionKey: accepted.runId,
    },
    async (input) => {
      await input.stream.writeTextDelta('Three')
      await input.stream.writeTextDelta(' tasks.')
      return completed('Three tasks.')
    },
  )

  expect(
    await state.ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, accepted.assistantMessageId))
      .get(),
  ).toMatchObject({
    content: 'Three tasks.',
    status: 'complete',
    revision: expect.any(Number),
  })
  expect(await state.ctx.db.select().from(agentRuns).get()).toMatchObject({
    id: accepted.runId,
    status: 'complete',
  })
})

test('shows an exact tool step before completing the answer', async () => {
  const state = await setup()
  const accepted = await acceptUserMessage(state.ctx, {
    userId: state.userId,
    content: 'Add book flights',
    clientMessageId: 'browser-tool-1',
  })

  await runAgentTurn(
    state.ctx,
    {
      threadId: state.thread.id,
      reason: 'message',
      runId: accepted.runId,
      executionKey: accepted.runId,
    },
    async (input) => {
      await input.tools.createTask({ title: 'Book flights' })
      return completed('Added “Book flights”.')
    },
  )

  expect(await state.ctx.db.select().from(agentRunSteps).all()).toMatchObject([
    {
      runId: accepted.runId,
      sequence: 1,
      kind: 'tool_call',
      title: 'createTask v1',
      status: 'complete',
      visibility: 'visible',
      input: { title: 'Book flights' },
      output: { title: 'Book flights' },
    },
  ])
})
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL because queued runs cannot be claimed and the responder has no
recorder-backed stream.

- [ ] **Step 3: Claim queued runs and attach the recorder**

For a supplied `runId`, claim either `queued` or
`waiting_for_approval` with a conditional update to `running`. Do not insert a
new run when an accepted message already supplied one. Construct one recorder
and controller:

```ts
const abortController = new AbortController()
const recorder = await createRunRecorder(ctx, run)
const stream = {
  signal: abortController.signal,
  writeTextDelta: (delta: string) => recorder.appendText(delta),
  writeStatus: async (title: string) => {
    const step = await recorder.startStep({
      kind: 'status',
      title,
      visibility: 'visible',
    })
    await recorder.finishStep(step.id)
  },
}
```

Pass `stream` into the responder. After a completed response, call
`recorder.replaceText(response.text)`, `recorder.flush()`, then
`recorder.finishMessage('complete')` before setting the run `complete`.
Existing system/commitment turns that have no reserved draft may create one at
run start through a small `ensureAssistantDraft` helper.

- [ ] **Step 4: Wrap tools with activity steps**

Around `invokeAgentTool`:

```ts
const definition = getAgentTool(toolId)
const step = await recorder.startStep({
  kind: 'tool_call',
  title: `${definition.id} v${definition.version}`,
  input: rawArgs,
  visibility: 'visible',
})
try {
  const result = await invokeAgentTool(ctx, invocation)
  if (result.status === 'done') {
    await recorder.finishStep(step.id, result.result)
  } else {
    await recorder.finishStep(step.id, { approvalRequired: true })
  }
  return result
} catch (error) {
  await recorder.failStep(step.id, error)
  throw error
}
```

Do not move the tool effect out of its current idempotent journal transaction.
The step is presentation state; `agentToolCalls` remains execution evidence.
Extend a successful invocation result so the wrapper can link presentation to
that evidence:

```ts
type ToolInvocationResult<T = unknown> =
  | { status: 'done'; result: T; toolCallId: string }
  | { status: 'approval_required'; requestId: string }
```

Have `recordExecution` return both the final journal row and the tool result;
existing callers continue reading `result`. Pass `toolCallId` into
`finishStep`, which stores it in `agentRunSteps.toolCallId`.

- [ ] **Step 5: Preserve approval suspension on the same draft**

When the responder requests approval, force-flush the recorder, leave the
assistant message at `streaming` if it has content or `queued` if empty, persist
the checkpoint, set the run `waiting_for_approval`, publish both canonical
rows, and release the thread lock. Resume reuses the existing run, draft, and
step sequence.

- [ ] **Step 6: Preserve partial progress on model and tool errors**

In the generic error branch, force-flush buffered text without replacing it,
fail any currently running presentation step, set the reserved assistant draft
and run to `error`, store the sanitized error message on the run, and publish
the canonical updates before rethrowing for the existing job policy. Add a
runtime test that emits partial text and then throws; assert the partial text
and completed earlier steps remain queryable with terminal `error` state.

- [ ] **Step 7: Run runtime, approval, and commitment regression tests**

Run:

```bash
bun test examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/approvals.test.ts examples/agent-chat/src/agent/commitments.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: PASS and exit 0.

- [ ] **Step 8: Commit the runtime slice**

```bash
git add examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/run-recorder.ts examples/agent-chat/src/agent/approvals.ts
git commit -m "feat(agent-chat): stream durable agent turns"
```

---

### Task 6: Durable stop command and cooperative worker cancellation

**Files:**

- Create: `examples/agent-chat/src/agent/cancellation.ts`
- Create: `examples/agent-chat/src/agent/cancellation.test.ts`
- Modify: `examples/agent-chat/src/agent/run-recorder.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/api.ts`
- Modify: `examples/agent-chat/src/api.test.ts`

**Interfaces:**

- Produces: `requestRunCancellation(ctx, { runId, userId })`.
- Produces API: `POST /api/agent/runs/{id}/stop` returning `{ id, status }`.
- Produces internal: `AgentRunCancelledError` used only to choose the cancelled terminal path.
- Guarantees: queued/waiting runs cancel immediately; running runs become cancelling; complete/error/cancelled calls are idempotent.

- [ ] **Step 1: Write failing cancellation tests**

```ts
test('the owner requests cancellation without deleting partial text', async () => {
  const state = await setupRunningRun('Partial answer')
  const result = await requestRunCancellation(state.ctx, {
    runId: state.run.id,
    userId: state.userId,
  })

  expect(result.status).toBe('cancelling')
  expect(await readMessage(state.ctx, state.assistant.id)).toMatchObject({
    content: 'Partial answer',
    status: 'streaming',
  })
})

test('a recorder observation turns cancelling into a durable cancellation', async () => {
  const state = await setupRunningRun('Partial answer')
  await requestRunCancellation(state.ctx, {
    runId: state.run.id,
    userId: state.userId,
  })

  await expect(state.recorder.checkCancellation()).rejects.toBeInstanceOf(
    AgentRunCancelledError,
  )
})
```

Add a runtime test whose responder emits no deltas and waits only for
`input.stream.signal.abort`; request Stop after it starts, then assert the job
settles as `cancelled` within a bounded test timeout. Add an API ownership test:
Alice receives 404 when stopping Bob's run.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/agent/cancellation.test.ts examples/agent-chat/src/api.test.ts
```

Expected: FAIL because the cancellation service and endpoint are absent.

- [ ] **Step 3: Implement conditional cancellation**

Use owner-scoped conditional updates. For `queued` and
`waiting_for_approval`, atomically set the run and assistant message to
`cancelled`, cancel any pending request belonging to the run through its
existing rejected path, and publish the returned rows. For `running`, update
only the run to `cancelling` and publish it. Return the existing row for an
already-terminal run.

- [ ] **Step 4: Make the recorder poll cancellation on flush**

Add `checkCancellation()` that reads only `{ status }` for the recorder's run.
Call it before every throttled database flush and immediately before and after
each tool invocation. If status is `cancelling`, abort the controller supplied
to the recorder and throw `AgentRunCancelledError`. Pass the same controller
signal into `AgentResponderStream`.

While the responder is active, also run a 150 ms cancellation monitor so Stop
works while the provider is silent:

```ts
let checking = false
const cancellationTimer = setInterval(async () => {
  if (checking || abortController.signal.aborted) return
  checking = true
  try {
    await recorder.checkCancellation()
  } catch (error) {
    if (error instanceof AgentRunCancelledError) abortController.abort(error)
  } finally {
    checking = false
  }
}, 150)
```

Clear the timer in `finally`. A tool effect that ignores the abort signal is
allowed to finish, but the post-invocation check must cancel the run before the
model continues.

In `runAgentTurn`, treat either a caught `AgentRunCancelledError` or an aborted
stream whose `signal.reason` is that error as cancellation before the generic
error branch. Use a final recorder flush mode that bypasses the cancellation
check, preserving any safe buffered text; mark the assistant message, current
running step, and run `cancelled`, publish them, and return
`{ status: 'cancelled' }` without causing a job retry.

- [ ] **Step 5: Implement the protected stop endpoint**

Use:

```ts
stopRun: o.protected
  .route({ method: 'POST', path: '/api/agent/runs/{id}/stop', tags: ['agent'] })
  .input(type({ id: 'string' }))
  .output(type({
    id: 'string',
    status: "'cancelling' | 'cancelled' | 'complete' | 'error'",
  }))
```

Map a missing or foreign run to `NOT_FOUND`.

- [ ] **Step 6: Verify cancellation and runtime regressions**

Run:

```bash
bun test examples/agent-chat/src/agent/cancellation.test.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/api.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: PASS and exit 0.

- [ ] **Step 7: Commit the cancellation slice**

```bash
git add examples/agent-chat/src/agent/cancellation.ts examples/agent-chat/src/agent/cancellation.test.ts examples/agent-chat/src/agent/run-recorder.ts examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/api.ts examples/agent-chat/src/api.test.ts
git commit -m "feat(agent-chat): stop durable agent runs"
```

---

### Task 7: Streaming message and activity-ledger presentation

**Files:**

- Create: `examples/agent-chat/src/components/RunActivity.tsx`
- Create: `examples/agent-chat/src/components/RunActivity.test.tsx`
- Create: `examples/agent-chat/src/components/StreamingMessage.tsx`
- Create: `examples/agent-chat/src/components/StreamingMessage.test.tsx`
- Create: `examples/agent-chat/src/components/streaming-text.ts`
- Create: `examples/agent-chat/src/components/streaming-text.test.ts`
- Modify: `examples/agent-chat/src/styles.css`

**Interfaces:**

- Produces: `RunActivity({ steps, hasAnswer, runStatus })`.
- Produces: `StreamingMessage({ message, steps, run, onStop })`.
- Produces pure helpers: `mergeRevisionedMessage(current, incoming)` and `nextTextFrame(current, target, amount)`.
- Visual rule: activity is expanded while answer content is empty and auto-collapses once on the empty-to-nonempty transition.

- [ ] **Step 1: Write failing pure presentation tests**

```ts
test('a stale revision cannot replace a newer message snapshot', () => {
  expect(
    mergeRevisionedMessage(
      { id: 'm1', content: 'new', revision: 4 },
      { id: 'm1', content: 'old', revision: 3 },
    ),
  ).toEqual({ id: 'm1', content: 'new', revision: 4 })
})

test('advances only toward an extending target', () => {
  expect(nextTextFrame('Hello', 'Hello world', 3)).toBe('Hello wo')
  expect(nextTextFrame('old', 'replacement', 3)).toBe('replacement')
})
```

- [ ] **Step 2: Write failing static component tests**

Render `RunActivity` with completed and running tool steps. Assert exact tool
arguments, results, and elapsed duration appear inside a `<details>`
disclosure. Render once with `hasAnswer={false}` and assert `open=""`; render
with `hasAnswer` and assert the summary `2 steps · 1 tool` is present without
an open attribute. Render
`StreamingMessage` with `status="streaming"` and assert a Stop button; render
with `status="cancelled"` and assert `Stopped by user`.

- [ ] **Step 3: Run component tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/components/streaming-text.test.ts examples/agent-chat/src/components/RunActivity.test.tsx examples/agent-chat/src/components/StreamingMessage.test.tsx
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the components and animation boundary**

`mergeRevisionedMessage` returns the record with the larger revision.
`nextTextFrame` returns the target immediately when it does not extend the
current text; otherwise it appends at most `amount` UTF-16 code units.

`StreamingMessage` initializes both its latest accepted snapshot and displayed
text from the full incoming record, so reload catch-up is immediate. On every
prop change, update snapshot state through `mergeRevisionedMessage`; only the
accepted higher revision may become the animation target, preventing a stale
subscription event from rolling text back. On later increasing revisions, use
`requestAnimationFrame` to advance 12–24 characters per frame. When
`matchMedia('(prefers-reduced-motion: reduce)')` matches, use the target
immediately. Render the displayed assistant content through the page's existing
Markdown path so formatting behavior does not regress while the snapshot grows.

`RunActivity` uses native `<details>`/`<summary>` for keyboard and mobile
access. A `useRef` detects the first empty-to-nonempty answer transition and
sets controlled open state to false; later manual user changes are respected.
Do not render hidden steps.

- [ ] **Step 5: Extend the existing agent-desk visual system**

Add only scoped classes:

- `.run-activity`: inset ledger with a left cyan rule;
- `.run-step`: mono sequence/status row;
- `.run-step--running`: acid status marker with one restrained pulse;
- `.stream-caret`: non-layout-shifting cursor after active text;
- `.message-terminal-note`: muted cancelled/error annotation.

Use existing CSS variables and fonts. Add `@media (prefers-reduced-motion:
reduce)` to disable the pulse and caret animation. On screens below 560 px,
make tool input/output `<pre>` blocks horizontally scrollable and keep Stop at
least 44 px high.

- [ ] **Step 6: Verify UI primitives**

Run:

```bash
bun test examples/agent-chat/src/components
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
```

Expected: PASS and exit 0.

- [ ] **Step 7: Commit the presentation slice**

```bash
git add examples/agent-chat/src/components/RunActivity.tsx examples/agent-chat/src/components/RunActivity.test.tsx examples/agent-chat/src/components/StreamingMessage.tsx examples/agent-chat/src/components/StreamingMessage.test.tsx examples/agent-chat/src/components/streaming-text.ts examples/agent-chat/src/components/streaming-text.test.ts examples/agent-chat/src/styles.css
git commit -m "feat(agent-chat): render streamed activity"
```

---

### Task 8: Conversation integration and one local queued message

**Files:**

- Create: `examples/agent-chat/src/components/QueuedMessage.tsx`
- Create: `examples/agent-chat/src/components/QueuedMessage.test.tsx`
- Create: `examples/agent-chat/src/components/queued-message.ts`
- Create: `examples/agent-chat/src/components/queued-message.test.ts`
- Create: `examples/agent-chat/src/hooks/useAgentChat.ts`
- Modify: `examples/agent-chat/src/routes/index.tsx`
- Modify: `examples/agent-chat/src/styles.css`

**Interfaces:**

- Consumes: generated queries for `agentMessages`, `agentRuns`, and `agentRunSteps`, plus `sendMessage` and `stopRun`.
- Produces: `useAgentChat`, which composes canonical queries, mutations,
  presentation-only queue state, and retry state without owning a second
  message history.
- Produces local state: at most one `{ clientMessageId, content, mode: 'after-current' | 'interrupt' }`.
- Guarantees: ordinary queue waits for a confirmed terminal run; interrupt queue calls Stop and still waits for the confirmed terminal row before sending.
- Guarantees: queued local input is never written to web storage.

- [ ] **Step 1: Write failing queue transition tests**

Use a pure transition helper so timing behavior is testable without a DOM:

```ts
test('waits while a run is active and sends after a terminal update', () => {
  const queued = {
    clientMessageId: 'local-1',
    content: 'Next question',
    mode: 'after-current' as const,
  }
  expect(queueAction(queued, 'running')).toEqual({ type: 'wait' })
  expect(queueAction(queued, 'complete')).toEqual({
    type: 'send',
    message: queued,
  })
})

test('interrupt requests stop until cancellation is confirmed', () => {
  const queued = {
    clientMessageId: 'local-1',
    content: 'Send now',
    mode: 'interrupt' as const,
  }
  expect(queueAction(queued, 'running')).toEqual({ type: 'stop' })
  expect(queueAction(queued, 'cancelling')).toEqual({ type: 'wait' })
  expect(queueAction(queued, 'cancelled')).toEqual({
    type: 'send',
    message: queued,
  })
})
```

Static-render `QueuedMessage` and assert its content, `Send now`, and `Remove
from queue` controls.

- [ ] **Step 2: Run queue tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/components/queued-message.test.ts examples/agent-chat/src/components/QueuedMessage.test.tsx
```

Expected: FAIL because queue modules do not exist.

- [ ] **Step 3: Integrate canonical run/message/step rendering**

Query `api.agentRunSteps.list` with a sufficient limit. Index runs and visible
steps by `runId` using `useMemo`. Replace the inline assistant article and
typing bubble with `StreamingMessage`. Keep user and system messages on their
existing Markdown path. Extract the chat-specific queries, `activeRun`, send
and stop mutations, retry identity, and local queue orchestration into
`useAgentChat`; keep page-wide task, commitment, memory, and approval queries
in `AgentDesk`.

Derive `activeRun` from statuses `queued`, `running`,
`waiting_for_approval`, or `cancelling`; do not derive server work only from
the thread lock. `isWorking` includes `activeRun` and the send mutation.

- [ ] **Step 4: Send accepted messages with stable client IDs**

Generate a `clientMessageId` once per composer submission with
`crypto.randomUUID()`. Keep it with the mutation variables until acceptance;
on a failed acceptance, restore the same content and ID so a retry is
idempotent. Do not generate the ID inside a retry callback. If acceptance
races another tab and receives the active-run conflict from Task 2, move the
same content and `clientMessageId` into the browser-local queue instead of
discarding it or generating a replacement ID.

- [ ] **Step 5: Add one-message local queue orchestration**

When submit occurs during `activeRun`, move the composer content into
`queuedMessage` and clear the composer without calling the API. Render
`QueuedMessage` after the active assistant draft.

Use one effect driven by `queueAction(queuedMessage, activeRun?.status)`:

- `wait`: do nothing;
- `stop`: call `stopRun` once per active run ID, then change the local mode to
  `after-current` so rerenders cannot repeat Stop;
- `send`: clear local queue first, then call `sendMessage`; if acceptance
  fails, restore its text and client ID to the composer retry state.

Removing the queue simply sets it to `null`. Do not read or write
`localStorage` or `sessionStorage`.

- [ ] **Step 6: Style the ephemeral row and mobile controls**

Use a dashed border, reduced opacity, and the existing mono label `Queued in
this tab`. Keep the content readable; do not use blur. At mobile width, stack
the two actions and maintain 44 px targets.

- [ ] **Step 7: Verify the route and components**

Run:

```bash
bun test examples/agent-chat/src/components examples/agent-chat/src/api.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
bun run --cwd examples/agent-chat build
```

Expected: tests, type checking, and production build exit 0.

- [ ] **Step 8: Commit the conversation slice**

```bash
git add examples/agent-chat/src/components/QueuedMessage.tsx examples/agent-chat/src/components/QueuedMessage.test.tsx examples/agent-chat/src/components/queued-message.ts examples/agent-chat/src/components/queued-message.test.ts examples/agent-chat/src/hooks/useAgentChat.ts examples/agent-chat/src/routes/index.tsx examples/agent-chat/src/styles.css examples/agent-chat/src/routeTree.gen.ts
git commit -m "feat(agent-chat): add resilient chat controls"
```

---

### Task 9: Recovery contract tests, documentation, and final verification

**Files:**

- Create: `examples/agent-chat/src/agent/recovery.test.ts`
- Modify: `examples/agent-chat/README.md`
- Review: every file changed in Tasks 1–8

**Interfaces:**

- Consumes: accepted runs, recorder snapshots, runtime, generated read API,
  and realtime publications.
- Produces: executable evidence that generation is independent of a browser
  response and a fresh reader reconstructs the latest snapshot.

- [ ] **Step 1: Write the end-to-end server recovery test**

The test uses no browser stream or request consumer:

```ts
test('a fresh reader sees the latest draft while the responder is still active', async () => {
  const state = await setup()
  const accepted = await acceptUserMessage(state.ctx, {
    userId: state.userId,
    content: 'Explain the tasks',
    clientMessageId: 'browser-1',
  })
  const firstDeltaPersisted = Promise.withResolvers<void>()
  const releaseResponder = Promise.withResolvers<void>()

  const running = runAgentTurn(
    state.ctx,
    {
      threadId: state.thread.id,
      reason: 'message',
      runId: accepted.runId,
      executionKey: accepted.runId,
    },
    async (input) => {
      await input.stream.writeStatus('Inspecting tasks')
      await input.stream.writeTextDelta('Current answer')
      firstDeltaPersisted.resolve()
      await releaseResponder.promise
      await input.stream.writeTextDelta(' completed')
      return completed('Current answer completed')
    },
  )

  await firstDeltaPersisted.promise
  expect(await readFreshSnapshot(state, accepted.assistantMessageId)).toMatchObject({
    content: 'Current answer',
    status: 'streaming',
  })
  expect(await state.ctx.db.select().from(agentRunSteps).all()).toMatchObject([
    { title: 'Inspecting tasks', status: 'complete' },
  ])

  releaseResponder.resolve()
  await running
  expect(await readFreshSnapshot(state, accepted.assistantMessageId)).toMatchObject({
    content: 'Current answer completed',
    status: 'complete',
  })
})
```

`readFreshSnapshot` must execute a new database query rather than reuse an
object captured from a publication. Add companion assertions that a stale
lower-revision record is rejected by `mergeRevisionedMessage`, and duplicate
message acceptance returns the same run.

- [ ] **Step 2: Run the recovery test**

Run: `bun test examples/agent-chat/src/agent/recovery.test.ts`

Expected: PASS. There is no browser `ReadableStream` whose cancellation could
affect `running`; only the test-controlled responder gates the job.

- [ ] **Step 3: Update the example README**

Document:

- command/observation separation;
- server-owned assistant drafts and 150 ms snapshot pacing;
- visible step ledger versus hidden chain-of-thought;
- reload, route-change, sleeping-tab, replay, and refetch behavior;
- Redis requirement for separate web/worker live fan-out;
- Stop semantics and the intentionally browser-local one-message queue;
- the current scope boundary excluding worker/provider continuation.

Remove the old implication that the UI only waits for a final message.

- [ ] **Step 4: Run focused complete-example verification**

Run:

```bash
bun test examples/agent-chat/src
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
bun run --cwd examples/agent-chat build
```

Expected: at least the baseline 77 tests plus all new tests pass, type checking
has zero diagnostics, and the build exits 0.

- [ ] **Step 5: Run workspace regression verification**

Run:

```bash
bun run typecheck:all
bun test
git diff --check
git status --short
```

Expected: workspace type checks and tests exit 0; `git diff --check` emits no
errors; the working tree is clean after the intended commits.

- [ ] **Step 6: Perform the manual browser recovery matrix**

Run `bun run dev:agent-chat`, use a configured model and prompts that trigger
both tools and multi-paragraph answers, and verify each observable outcome:

1. reload after the first text appears: the full stored snapshot appears
   immediately and then continues;
2. navigate away and return: the run continues and the current draft is shown;
3. put a mobile-sized tab in the background and resume: reconnect/refetch
   catches up without a second run;
4. disconnect network after acceptance and reconnect: no duplicate user
   message or run appears;
5. Stop during text: partial text remains with `Stopped by user`;
6. queue one message: it sends after the confirmed terminal status;
7. choose Send now: Stop is confirmed before the queued message is accepted;
8. reload with a local queued message: it disappears as designed;
9. expand a completed activity ledger: exact demo tool input and output remain
   available.

- [ ] **Step 7: Commit documentation and recovery evidence**

```bash
git add examples/agent-chat/src/agent/recovery.test.ts examples/agent-chat/README.md
git commit -m "test(agent-chat): verify streaming recovery"
```
