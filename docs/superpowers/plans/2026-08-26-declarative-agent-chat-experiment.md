# Declarative Agent Chat Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `examples/agent-chat` into an app-local experiment for declaring one personal agent with typed tools, bounded context, durable memory/inbox, user approvals and grants, and anonymous-to-password account upgrade.

**Architecture:** Keep all agent abstractions inside the example. The existing unique `agentThreads.userId` row remains the personal agent instance and Bunderstack continues to supply auth, database, jobs, realtime, and generated read-only CRUD. Model-visible tools delegate to server-side definitions whose runtime enforces user scoping, approval policy, persistent grants, exact event capabilities, idempotent execution, and audit before effects occur.

**Tech Stack:** Bun, TypeScript, Bunderstack, Drizzle/libSQL, Better Auth anonymous + email/password, TanStack Start/Query, React, AI SDK, Zod, ArkType.

**Spec:** `docs/plans/2026-08-26-declarative-agent-chat-experiment-design.md`

## Global Constraints

- Work only in `examples/agent-chat`, its migrations, its README, and this plan unless a verified Bunderstack defect blocks the experiment.
- Do not add a public Bunderstack API, package, package export, or framework-level `agent` config key.
- Keep one agent definition and one unique agent thread per user. Do not add spaces, memberships, multiple agents, delegation, service identities, or a generalized actor model.
- Use Better Auth's anonymous plugin for anonymous identity and `onLinkAccount` for data transfer.
- Keep the deterministic responder and make the example runnable without an AI credential.
- The model never supplies or chooses `userId`, never receives raw database access, and never authorizes an effect.
- Tool policies are hard minimums. A persistent grant or exact event capability can satisfy a rememberable approval; only the user creates a persistent grant.
- External/untrusted content cannot create capabilities or trusted long-term memory.
- Follow strict TDD for every behavior change: write the test, run it and observe the expected failure, implement the minimum, then rerun green.
- Use Bun commands (`bun test`, `bun run`, `bunx`) rather than Node/npm/pnpm.
- Preserve unrelated changes outside the isolated worktree.

---

## File structure

New focused modules:

- `src/agent/declaration.ts` — `defineAgent`, `defineTool`, tool policy and event declaration types.
- `src/agent/definition.ts` — the one app-local agent, tool definitions, instructions, context limits, and event policies.
- `src/agent/policy.ts` — pure grant/capability matching and permission decisions.
- `src/agent/context.ts` — bounded context assembly from conversation, tasks, memory, and inbox.
- `src/agent/memory.ts` — validated memory writes, edits, and deletion.
- `src/agent/inbox.ts` — durable event insertion, dedupe, delivery, aggregation, and acknowledgement.
- `src/agent/approvals.ts` — durable request resolution, exact frozen-call execution, grants, and revocation.
- `src/agent/friendly-name.ts` — deterministic-testable friendly anonymous-name generation.
- `src/agent/auth-transfer.ts` — transactional anonymous-user data transfer.
- `src/components/MemoryPanel.tsx` — inspect/edit/delete memory UI.
- `src/components/ApprovalPanel.tsx` — pending approval and persistent grant UI.
- `src/components/SaveAgentPanel.tsx` — optional email/password upgrade UI.

Existing modules remain focused:

- `src/agent/runtime.ts` owns wake/locking/run lifecycle and invokes the new boundaries.
- `src/agent/model.ts` adapts the app-local declaration to deterministic and AI SDK responders.
- `src/api.ts` exposes protected user actions; it contains no agent business logic.
- `src/schema.ts` owns application tables and indexes.
- `src/access.ts` keeps browser reads user-scoped and all agent writes denied through generated CRUD.

---

### Task 1: App-local agent and tool declarations

**Files:**

- Create: `examples/agent-chat/src/agent/declaration.ts`
- Create: `examples/agent-chat/src/agent/declaration.test.ts`
- Create: `examples/agent-chat/src/agent/definition.ts`
- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/agent/model.ts`
- Modify: `examples/agent-chat/src/agent/model.test.ts`

**Interfaces:**

- Produces `defineTool(config)`, `defineAgent(config)`, `ToolDefinition`, `AgentDefinition`, `ToolExecutionContext`, `AgentEventDefinition`, and the exported singleton `agentDefinition`.
- `ToolDefinition` has exact fields `id`, `version`, `description`, `inputSchema`, `approval`, and `execute`.
- `approval` is `{ mode: 'none' }` or `{ mode: 'required'; remember: boolean }`.
- `AgentDefinition` has `instructions`, `tools`, `events`, and context limits for conversation, inbox, and memory.
- The model adapter consumes `agentDefinition` rather than declaring descriptions and schemas a second time.

- [x] **Step 1: Write failing declaration tests**

Add tests proving a declared tool retains its literal ID/version/policy and validates input through its Zod schema, and proving the AI responder exposes the singleton declaration's tool IDs. The behavior assertion must fail when `defineTool`/`agentDefinition` do not exist; do not assert source text.

```ts
test('a declared tool exposes one validated server capability', () => {
  const tool = defineTool({
    id: 'echo',
    version: 1,
    description: 'Echo text.',
    inputSchema: z.object({ text: z.string().min(1) }),
    approval: { mode: 'none' },
    execute: async ({ text }) => ({ text }),
  })

  expect(tool.inputSchema.parse({ text: 'hello' })).toEqual({ text: 'hello' })
  expect(() => tool.inputSchema.parse({ text: '' })).toThrow()
  expect(tool.id).toBe('echo')
})
```

- [x] **Step 2: Run the focused tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/declaration.test.ts examples/agent-chat/src/agent/model.test.ts`

Expected: FAIL because the declaration API and singleton definition are absent.

- [x] **Step 3: Implement the declaration API and singleton definition**

Define these stable shapes:

```ts
export type ToolApprovalPolicy =
  | { mode: 'none' }
  | { mode: 'required'; remember: boolean }

export interface ToolExecutionContext {
  runtime: AgentRuntimeContext
  userId: string
  threadId: string
  runId: string
  trigger: { type: 'user' | 'system'; trusted: boolean; sourceId?: string }
}

export function defineTool<const TId extends string, TInput, TOutput>(config: {
  id: TId
  version: number
  description: string
  inputSchema: z.ZodType<TInput>
  approval: ToolApprovalPolicy
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>
}): ToolDefinition<TId, TInput, TOutput>
```

The singleton definition initially declares the four existing task/reminder
tools (`listTasks`, `createTask`, `completeTask`, and `scheduleReminder`) with
`{ mode: 'none' }`. Task 3 adds `deleteTask` only after approval enforcement
exists; Task 4 adds `remember` only after trusted memory writes exist. This
keeps every intermediate commit safe and runnable.

Make `createAIResponder` build its AI SDK `tools` map from the declaration. Keep `createDemoResponder` deterministic and its existing commands green; add deterministic parsing for `Delete <task title>` and `Remember that <text>` only after the declaration is wired.

- [x] **Step 4: Run focused tests until GREEN**

Run: `bun test examples/agent-chat/src/agent/declaration.test.ts examples/agent-chat/src/agent/model.test.ts`

Expected: PASS with no network calls.

- [x] **Step 5: Commit**

```bash
git add examples/agent-chat/src/agent
git commit -m "refactor(agent-chat): declare agent tools locally"
```

---

### Task 2: Durable memory, inbox, requests, and grants schema

**Files:**

- Modify: `examples/agent-chat/src/schema.ts`
- Modify: `examples/agent-chat/src/access.ts`
- Modify: `examples/agent-chat/src/test-app.ts`
- Create: `examples/agent-chat/src/agent/schema.test.ts`
- Create: generated files under `examples/agent-chat/migrations/`

**Interfaces:**

- Produces Drizzle tables `agentMemory`, `agentInbox`, `agentRequests`, and `agentToolGrants`.
- All four carry `userId`; inbox and requests also carry `threadId`; grants carry `threadId` because the unique thread is the personal agent instance.
- Generated CRUD permits authenticated, user-scoped list/get only. Create/update/delete remain denied.

- [x] **Step 1: Write failing schema integration tests**

Use the real in-memory test app. Insert two users and prove each new table accepts owned rows with TypeIDs, JSON payloads round-trip, and the required status defaults are applied. Add an API access test proving one user's list cannot return another user's memory or grants.

Required table behavior:

```ts
agentMemory: {
  id: TypeId<'amem'>,
  userId,
  kind: 'preference' | 'fact' | 'summary',
  key,
  value,
  sourceType: 'user' | 'system' | 'derived',
  sourceId: nullable string,
  createdAt,
  updatedAt,
}

agentInbox: {
  id: TypeId<'ainbox'>,
  threadId,
  userId,
  type,
  payload: JSON object,
  delivery: 'immediate' | 'next_turn' | 'silent',
  aggregate: 'latest' | 'collect' | 'count',
  dedupeKey: nullable string,
  status: 'pending' | 'consumed' | 'expired',
  expiresAt: nullable date,
  consumedAt: nullable date,
  createdAt,
}

agentRequests: {
  id: TypeId<'arequest'>,
  threadId,
  userId,
  runId,
  kind: 'input' | 'approval',
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'expired',
  prompt,
  tool: nullable string,
  toolVersion: nullable integer,
  args: nullable JSON object,
  result: nullable JSON value,
  expiresAt: nullable date,
  createdAt,
  resolvedAt: nullable date,
}

agentToolGrants: {
  id: TypeId<'agrant'>,
  threadId,
  userId,
  tool,
  toolVersion,
  scope: JSON object,
  status: 'active' | 'revoked' | 'expired',
  grantedAt,
  expiresAt: nullable date,
  lastUsedAt: nullable date,
  revokedAt: nullable date,
}
```

Add unique `(userId, key)` memory semantics and indexes supporting pending inbox by user/thread, pending requests by user/thread, and active grants by user/thread/tool/version.

- [x] **Step 2: Run schema tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/schema.test.ts`

Expected: FAIL because the tables do not exist.

- [x] **Step 3: Implement tables, access rules, and test setup**

Use `generateTypeId`/`typeid` conventions already present. Keep generated CRUD mutations denied and add filter/sort columns needed by the UI. Do not expose raw rows across users.

- [x] **Step 4: Generate the migration**

Run: `bun run --cwd examples/agent-chat db:generate`

Expected: a new Drizzle migration and updated migration metadata, generated from the schema rather than hand-authored.

- [x] **Step 5: Run schema and existing runtime tests until GREEN**

Run: `bun test examples/agent-chat/src/agent/schema.test.ts examples/agent-chat/src/agent/runtime.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add examples/agent-chat/src/schema.ts examples/agent-chat/src/access.ts examples/agent-chat/src/test-app.ts examples/agent-chat/src/agent/schema.test.ts examples/agent-chat/migrations
git commit -m "feat(agent-chat): add durable agent state tables"
```

---

### Task 3: Tool policy, approvals, exact capabilities, and grants

**Files:**

- Create: `examples/agent-chat/src/agent/policy.ts`
- Create: `examples/agent-chat/src/agent/policy.test.ts`
- Create: `examples/agent-chat/src/agent/approvals.ts`
- Create: `examples/agent-chat/src/agent/approvals.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/definition.ts`
- Modify: `examples/agent-chat/src/agent/types.ts`

**Interfaces:**

- Produces `allowTool(tool, args)`, `evaluateToolPermission(input)`, `invokeAgentTool(...)`, `resolveApproval(...)`, and `revokeToolGrant(...)`.
- Permission decisions are `allow`, `approval_required`, or `deny`.
- Capabilities and frozen-call comparison use parsed exact arguments and are never placed in model-visible messages.

- [x] **Step 1: Write failing pure policy tests**

Cover these literal cases:

- no-approval tool returns `allow`;
- required tool without grant/capability returns `approval_required`;
- matching active grant with identical tool/version returns `allow`;
- revoked, expired, wrong-user, wrong-thread, wrong-version grants do not match;
- an exact event capability allows identical parsed arguments;
- changing `postId`, channel, or any nested argument stops a capability match.

Use `isDeepStrictEqual` or an equivalently real structural comparison. Do not authorize by substring or model output.

- [x] **Step 2: Run policy tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/policy.test.ts`

Expected: FAIL because policy functions are absent.

- [x] **Step 3: Implement the pure policy engine**

`evaluateToolPermission` first honors `{ mode: 'none' }`, then exact active grants, then exact capabilities, and otherwise requests approval. A hard invalid/unknown tool is denied before this function is called.

- [x] **Step 4: Run policy tests until GREEN**

Run: `bun test examples/agent-chat/src/agent/policy.test.ts`

Expected: PASS.

- [x] **Step 5: Write failing approval integration tests**

Using the real in-memory app, prove:

1. `deleteTask` without a grant inserts one pending approval and does not delete the task.
2. `allow_once` atomically resolves that request and executes exactly its frozen task ID once.
3. Replaying the same resolution does not execute again.
4. `always_allow` creates one active user/thread/tool/version grant and executes the call.
5. A later matching delete skips approval and updates `lastUsedAt`.
6. Revoking the grant makes the next delete require approval again.
7. Resolving another user's request is forbidden.

- [x] **Step 6: Run approval tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/approvals.test.ts`

Expected: FAIL because approval execution is absent.

- [x] **Step 7: Implement invocation, approval resolution, and grant revocation**

Validate raw arguments with the tool's Zod schema before policy evaluation. Store the parsed frozen arguments. `invokeAgentTool` records successful/failed executions in `agentToolCalls`; pending approval is represented by `agentRequests` and returns:

```ts
{ status: 'approval_required', requestId: string }
```

`resolveApproval` accepts only `allow_once`, `always_allow`, or `reject`. It conditionally updates a pending request before any effect, executes only the definition matching the frozen tool/version, and wakes the agent with a trusted `tool.approval_resolved` system trigger after execution or rejection. Use a stable per-request idempotency boundary so retries cannot repeat the delete.

Add `deleteTask` to `agentDefinition` in this step, with version `1`, a Zod
`{ taskId: string }` input, and `{ mode: 'required', remember: true }`. Its
effect must delete only a task owned by `ctx.userId`.

- [x] **Step 8: Run focused agent tests until GREEN**

Run: `bun test examples/agent-chat/src/agent/policy.test.ts examples/agent-chat/src/agent/approvals.test.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/model.test.ts`

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add examples/agent-chat/src/agent
git commit -m "feat(agent-chat): enforce tool approvals and grants"
```

---

### Task 4: Bounded context, memory, and durable system inbox

**Files:**

- Create: `examples/agent-chat/src/agent/context.ts`
- Create: `examples/agent-chat/src/agent/context.test.ts`
- Create: `examples/agent-chat/src/agent/memory.ts`
- Create: `examples/agent-chat/src/agent/memory.test.ts`
- Create: `examples/agent-chat/src/agent/inbox.ts`
- Create: `examples/agent-chat/src/agent/inbox.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/model.ts`
- Modify: `examples/agent-chat/src/agent/types.ts`

**Interfaces:**

- Produces `assembleAgentContext`, `remember`, `updateMemory`, `deleteMemory`, `sendAgentEvent`, and `acknowledgeInbox`.
- `AgentResponderInput` gains bounded `memory` and `inbox` arrays and no longer depends on runtime loading every row inline.
- `sendAgentEvent` derives event delivery/aggregation/capabilities from `agentDefinition.events`; callers cannot supply authority in payload text.

- [x] **Step 1: Write failing memory tests**

Prove that trusted user/system sources can upsert `(userId, key)`, edit, and delete memory; another user cannot edit/delete it; an untrusted source is rejected; and an upsert preserves one row while updating `value`, `sourceType`, `sourceId`, and `updatedAt`.

- [x] **Step 2: Run memory tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/memory.test.ts`

Expected: FAIL because memory operations are absent.

- [x] **Step 3: Implement memory operations and run GREEN**

Run: `bun test examples/agent-chat/src/agent/memory.test.ts`

Expected: PASS.

- [x] **Step 4: Write failing inbox tests**

Prove:

- `immediate` inserts pending inbox and enqueues a turn;
- `next_turn` inserts pending inbox without enqueueing;
- `silent` is stored but excluded from automatic context;
- the same non-null dedupe key does not create a second pending row;
- expired events become `expired` and are not selected;
- successful acknowledgement marks only selected rows consumed;
- `latest`, `collect`, and `count` produce bounded literal context items.

- [x] **Step 5: Run inbox tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/inbox.test.ts`

Expected: FAIL because inbox operations are absent.

- [x] **Step 6: Implement inbox operations and run GREEN**

Run: `bun test examples/agent-chat/src/agent/inbox.test.ts`

Expected: PASS.

- [x] **Step 7: Write failing context/runtime tests**

Seed more than the configured limits and assert that context contains exactly the most recent 20 conversation messages, at most 10 aggregated non-silent inbox items, at most 8 memory rows, current tasks, the trigger, and the singleton instructions. Assert a successful turn acknowledges selected inbox rows; a failed turn leaves them pending. Assert an empty/no-action response creates no assistant message.

- [x] **Step 8: Run context/runtime tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/context.test.ts examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL because runtime still assembles context inline.

- [x] **Step 9: Implement the context boundary and refactor runtime/model**

Keep the turn lock and `wakeSeq` recovery behavior unchanged. `runAgentTurn` calls `assembleAgentContext`, creates tool wrappers from the singleton declaration, acknowledges selected inbox only after an intentional non-failed outcome, and persists an assistant message only when responder text is non-empty.

Add deterministic `Remember that <text>` behavior that stores one user-sourced `fact` under a stable normalized key suitable for the demo, and make AI instructions include memory and aggregated inbox as clearly delimited data rather than higher-priority instructions.

Add `remember` to `agentDefinition` in this step, with version `1`, a Zod
`{ key: string; value: string }` input, `{ mode: 'none' }`, and execution that
delegates to the trusted-source memory operation.

- [x] **Step 10: Run all focused agent tests until GREEN**

Run: `bun test examples/agent-chat/src/agent`

Expected: PASS with no network calls.

- [x] **Step 11: Commit**

```bash
git add examples/agent-chat/src/agent
git commit -m "feat(agent-chat): add bounded memory and system inbox"
```

---

### Task 5: Route reminders through declared events and expose protected actions

**Files:**

- Modify: `examples/agent-chat/src/api.ts`
- Modify: `examples/agent-chat/src/api-mount.test.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/src/agent/definition.ts`
- Create: `examples/agent-chat/src/api.test.ts`

**Interfaces:**

- Protected APIs expose `sendMessage`, `updateMemory`, `deleteMemory`, `resolveApproval`, and `revokeGrant`.
- All user IDs come from protected context, never input.
- `fireCommitment` emits declared `task.reminder_due` inbox instead of directly inserting an ad hoc system conversation message.

- [x] **Step 1: Write failing reminder-event test**

Update the existing commitment test to assert one fired commitment creates one pending `task.reminder_due` inbox event, wakes the same thread once, and remains idempotent on a second job delivery. The model's later turn, not `fireCommitment`, owns any assistant conversation message.

- [x] **Step 2: Run runtime test and observe RED**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL because `fireCommitment` still writes a system message directly.

- [x] **Step 3: Implement declared reminder event flow and run GREEN**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: PASS.

- [x] **Step 4: Write failing protected API tests**

Use real procedure clients and sessions as existing Bunderstack API tests do. Prove unauthorized calls fail; user A cannot mutate user B's memory/request/grant even when supplying B's row ID; valid owner calls update/delete/resolve/revoke and publish realtime changes.

- [x] **Step 5: Run API tests and observe RED**

Run: `bun test examples/agent-chat/src/api.test.ts examples/agent-chat/src/api-mount.test.ts`

Expected: FAIL because the protected procedures are absent.

- [x] **Step 6: Implement thin protected procedures**

Define ArkType input/output schemas. Handlers resolve `context.user.id`, delegate to the agent modules, and return stable IDs/status values. They contain no duplicated policy or Drizzle mutation logic beyond the existing `sendMessage` entry boundary.

- [x] **Step 7: Run API and focused agent tests until GREEN**

Run: `bun test examples/agent-chat/src/api.test.ts examples/agent-chat/src/api-mount.test.ts examples/agent-chat/src/agent`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add examples/agent-chat/src/api.ts examples/agent-chat/src/api.test.ts examples/agent-chat/src/api-mount.test.ts examples/agent-chat/src/agent
git commit -m "feat(agent-chat): expose agent memory and approval actions"
```

---

### Task 6: Anonymous friendly names and `Save your agent` account upgrade

**Files:**

- Create: `examples/agent-chat/src/agent/friendly-name.ts`
- Create: `examples/agent-chat/src/agent/friendly-name.test.ts`
- Create: `examples/agent-chat/src/agent/auth-transfer.ts`
- Create: `examples/agent-chat/src/agent/auth-transfer.test.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/src/components/LoginGate.tsx`
- Modify: `examples/agent-chat/src/utils/session.ts`

**Interfaces:**

- Produces `generateFriendlyName(random?)` and `transferAnonymousAgentData(db, fromUserId, toUserId)`.
- Better Auth config enables email/password and configures anonymous `generateName` and `onLinkAccount` using the schema-typed auth factory.
- The initial anonymous entry requires no typed name.

- [x] **Step 1: Write failing friendly-name tests**

Inject literal random values and assert human-readable adjective/animal output. Cover the lower and upper selection boundaries without relying on nondeterministic `Math.random`.

- [x] **Step 2: Run name tests and observe RED**

Run: `bun test examples/agent-chat/src/agent/friendly-name.test.ts`

Expected: FAIL because the generator is absent.

- [x] **Step 3: Implement the name generator and run GREEN**

Use compact, non-offensive English word lists matching the existing English UI. The function returns exactly `Adjective Animal`.

- [x] **Step 4: Write failing transfer integration test**

Seed an anonymous user with a thread, messages, runs, tool calls, commitments, tasks, memory, inbox, requests, and grants plus a fresh permanent user. Call `transferAnonymousAgentData` and assert every row now belongs to the permanent user, no row remains on the anonymous ID, and deleting the anonymous user does not cascade-delete transferred data.

- [x] **Step 5: Run transfer test and observe RED**

Run: `bun test examples/agent-chat/src/agent/auth-transfer.test.ts`

Expected: FAIL because transfer is absent.

- [x] **Step 6: Implement transactional transfer and Better Auth hooks**

Use the auth factory form `auth: ({ db }) => ({ ... })`. Enable `emailAndPassword: { enabled: true }`. Configure `anonymous({ generateName, onLinkAccount })`; `onLinkAccount` calls `transferAnonymousAgentData(db, anonymousUser.user.id, newUser.user.id)` before Better Auth deletes the anonymous user. Update child rows safely around the unique thread relationship and keep the operation transactional.

The experiment covers sign-up into a fresh account. If the destination already owns an agent thread, reject the transfer with a clear error rather than merging histories.

- [x] **Step 7: Replace the name form with one-click anonymous entry**

`LoginGate` shows the product explanation and one `Continue anonymously` button. It calls only `authClient.signIn.anonymous()` and invalidates the router; it does not call `updateUser`.

Expose `isAnonymous` in `fetchUser` so the agent desk can conditionally show the save panel in Task 7.

- [x] **Step 8: Run focused tests and type checking until GREEN**

Run: `bun test examples/agent-chat/src/agent/friendly-name.test.ts examples/agent-chat/src/agent/auth-transfer.test.ts`

Run: `bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: both exit 0.

- [x] **Step 9: Commit**

```bash
git add examples/agent-chat/src/agent/friendly-name.ts examples/agent-chat/src/agent/friendly-name.test.ts examples/agent-chat/src/agent/auth-transfer.ts examples/agent-chat/src/agent/auth-transfer.test.ts examples/agent-chat/src/bunderstack.ts examples/agent-chat/src/components/LoginGate.tsx examples/agent-chat/src/utils/session.ts
git commit -m "feat(agent-chat): add anonymous account upgrade"
```

---

### Task 7: Agent desk memory, approvals, grants, and save-account UI

**Files:**

- Create: `examples/agent-chat/src/components/MemoryPanel.tsx`
- Create: `examples/agent-chat/src/components/MemoryPanel.test.tsx`
- Create: `examples/agent-chat/src/components/ApprovalPanel.tsx`
- Create: `examples/agent-chat/src/components/ApprovalPanel.test.tsx`
- Create: `examples/agent-chat/src/components/SaveAgentPanel.tsx`
- Create: `examples/agent-chat/src/components/SaveAgentPanel.test.tsx`
- Modify: `examples/agent-chat/src/routes/index.tsx`
- Modify: `examples/agent-chat/src/router.tsx`
- Modify: `examples/agent-chat/src/styles.css`

**Interfaces:**

- `MemoryPanel` consumes scoped memory rows and protected update/delete mutations.
- `ApprovalPanel` consumes pending requests and active grants; it exposes `Allow now`, `Always allow`, `Reject`, and `Revoke` actions.
- `SaveAgentPanel` is shown only for `isAnonymous` users and calls Better Auth email sign-up with the current friendly name.

- [x] **Step 1: Write failing presentational component tests**

Use `renderToStaticMarkup` from `react-dom/server` with literal props. Prove
`MemoryPanel` renders kind/key/value plus labeled Edit/Delete actions,
`ApprovalPanel` renders pending tool/arguments plus `Allow now`, `Always allow`,
`Reject`, and active-grant `Revoke` actions, and `SaveAgentPanel` renders labeled
email/password fields and `Save your agent`. These tests must fail because the
components do not exist; do not test source text or mocks.

- [x] **Step 2: Run component tests and observe RED**

Run: `bun test examples/agent-chat/src/components/MemoryPanel.test.tsx examples/agent-chat/src/components/ApprovalPanel.test.tsx examples/agent-chat/src/components/SaveAgentPanel.test.tsx`

Expected: FAIL because the components are absent.

- [x] **Step 3: Implement the prop-driven components and run GREEN**

Keep data loading outside the presentational components. Pass rows, pending
state, errors, and callbacks as props so server rendering exercises the real
conditional UI without a browser mock.

Run: `bun test examples/agent-chat/src/components/MemoryPanel.test.tsx examples/agent-chat/src/components/ApprovalPanel.test.tsx examples/agent-chat/src/components/SaveAgentPanel.test.tsx`

Expected: PASS.

- [x] **Step 4: Wire queries and mutations in the agent desk**

Query `agentMemory`, `agentRequests`, and `agentToolGrants` using generated read-only APIs. Add protected mutations through the custom API. After a successful mutation, invalidate the affected queries. Keep existing realtime invalidation subscriptions for all new table names.

- [x] **Step 5: Complete the memory panel integration**

Show memory kind/key/value/source. Provide explicit edit, save, cancel, and delete controls with accessible labels. Editing changes the next turn's context; do not mutate generated CRUD directly.

- [x] **Step 6: Complete approval and grant integration**

Pending approvals show the tool name and frozen argument summary. Buttons map exactly to `allow_once`, `always_allow`, and `reject`. Active grants show tool/version, granted time, last-used time, and `Revoke`. Never render hidden capability data.

- [x] **Step 7: Complete the non-blocking save integration**

Show `Save your agent` only for anonymous users. Ask for email/password, call:

```ts
authClient.signUp.email({
  email,
  password,
  name: userName,
})
```

On success, invalidate the router and queries without leaving the desk. Show Better Auth errors inline. Do not require email verification.

- [x] **Step 8: Extend the existing visual language**

Keep the current technical desk aesthetic and responsive one-column behavior. Add the three panels to the runtime rail or a clearly subordinate section; do not redesign the application. Every control needs visible focus, disabled/pending state, and text that does not rely on color.

- [x] **Step 9: Run component tests, build, and typecheck**

Run: `bun test examples/agent-chat/src/components`

Run: `bun run --cwd examples/agent-chat build`

Run: `bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: all three commands exit 0.

- [x] **Step 10: Commit**

```bash
git add examples/agent-chat/src/components examples/agent-chat/src/routes/index.tsx examples/agent-chat/src/router.tsx examples/agent-chat/src/styles.css
git commit -m "feat(agent-chat): expose agent memory and permissions"
```

---

### Task 8: Documentation and repository verification

**Files:**

- Modify: `examples/agent-chat/README.md`
- Review: every file changed by Tasks 1-7

**Interfaces:**

- Documents the implemented app-local experiment without claiming a public Bunderstack API.
- Produces fresh verification evidence for focused tests, type checking, production build, and repository-wide compatibility.

- [x] **Step 1: Update the example README**

Document the one-click anonymous flow, `Save your agent`, app-local declaration, bounded context, memory editor, system inbox delivery modes, approval/grant lifecycle, event capabilities, security boundaries, and explicit non-goals. Retain the existing provider configuration and worker/deployment notes. State that the API is intentionally unstable and app-local.

- [x] **Step 2: Run focused tests**

Run: `bun test examples/agent-chat/src`

Expected: all agent-chat tests pass with zero failures and no network requirement.

- [x] **Step 3: Run example typecheck and production build**

Run: `bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Run: `bun run --cwd examples/agent-chat build`

Expected: both exit 0.

- [x] **Step 4: Run workspace verification**

Run: `bun run typecheck:all`

Run: `bun test`

Expected: type checking succeeds. Tests have no new failures; if the repository's documented sandbox-only S3 loopback baseline occurs, record exact test names/output and rerun the agent-chat suite separately to prove the feature itself is green.

- [x] **Step 5: Inspect the final diff**

Run: `git diff --check $(git merge-base main HEAD)..HEAD`

Run: `git status --short`

Expected: no whitespace errors and only intentional agent-chat, migration, README, and plan changes. Do not include unrelated files.

- [x] **Step 6: Commit documentation or final fixes**

```bash
git add examples/agent-chat/README.md
git commit -m "docs(agent-chat): document declarative agent experiment"
```

Skip the commit only when the README is unchanged and there are no final fixes.

---

## Executor handoff

Execute all eight tasks sequentially in the isolated worktree. The user explicitly requested one `gpt-5.6-terra` implementation subagent for the entire plan, so do not dispatch further subagents. The implementer must keep a task-by-task ledger in its report, follow RED-GREEN TDD, commit each completed task, and stop only for a destructive/security-sensitive action or a truly blocking contradiction with the design.
