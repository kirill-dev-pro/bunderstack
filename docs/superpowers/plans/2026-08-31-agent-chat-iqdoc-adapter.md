# Agent Chat IQdoc Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an IQdoc upstream-agent option to `examples/agent-chat` while retaining Bunderstack's durable streaming and recovery behavior.

**Architecture:** A focused IQdoc module wraps an OpenAI-compatible provider with an SSE interceptor that translates IQdoc status and calculator extensions into the existing durable stream observer. A pure provider factory selects the IQdoc or existing responder from environment-derived options; the worker runtime and database remain provider-neutral.

**Tech Stack:** Bun, TypeScript, AI SDK 7, `@ai-sdk/openai-compatible` 3, Bunderstack jobs/realtime, Drizzle/libSQL.

**Spec:** `docs/superpowers/specs/2026-08-31-agent-chat-iqdoc-adapter-design.md`

## Global Constraints

- Work directly in the existing `main` checkout as requested; do not create a worktree.
- Modify only the Bunderstack repository; treat `/Users/kirill/Projects/medach/iqdoc.ai` as a read-only protocol reference.
- IQdoc is the upstream agent and receives no Bunderstack tools.
- Keep the database as source of truth and the provider response owned by the worker.
- Reuse existing message snapshots and `agentRunSteps`; do not add a migration.
- Convert TypeID thread/run identifiers to their embedded UUIDv7 values for IQdoc correlation headers.
- Do not persist or expose hidden chain-of-thought.
- Default tests must use injected fetch fixtures and require no live IQdoc secret.
- Introduce every production behavior through a failing test and commit after each independently green task.

---

### Task 1: IQdoc SSE extension interceptor

**Files:**

- Create: `examples/agent-chat/src/agent/iqdoc.ts`
- Create: `examples/agent-chat/src/agent/iqdoc.test.ts`

**Interfaces:**

- Produces: `IQDocCalculatorResult` structured provider result.
- Produces: `createIQDocInterceptingFetch(fetch, callbacks)` returning a standard `typeof fetch`.
- Calls: `callbacks.onStatus(text)` once for each changed status.
- Calls: `callbacks.onCalculatorResult(result)` for every valid calculator result.
- Forwards: valid OpenAI SSE with provider-only events removed and mixed text events retained.

- [ ] **Step 1: Write failing fixture tests for status and calculator translation**

Create tests using an injected fetch that returns a `ReadableStream<Uint8Array>`
whose chunks split an SSE event in the middle. Consume the returned response as
text and assert literal behavior:

```ts
expect(statuses).toEqual(['Searching PubMed', 'Preparing answer'])
expect(calculators).toEqual([
  {
    ok: true,
    calculator_id: 'bmi',
    name: 'BMI',
    values: { result: 24.2 },
  },
])
expect(forwarded).toContain('"content":"Result"')
expect(forwarded).not.toContain('calculator_result')
expect(forwarded).not.toContain('Searching PubMed')
```

Add a separate mixed-delta fixture containing both `content` and `status` and
assert that content is forwarded but the `status` key is removed. Add malformed
JSON, `[DONE]`, keepalive comments, non-SSE, and failed-response cases and
assert they pass through without throwing.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test examples/agent-chat/src/agent/iqdoc.test.ts
```

Expected: FAIL because `./iqdoc` does not exist.

- [ ] **Step 3: Implement the minimal byte-safe SSE interceptor**

Define the callback boundary:

```ts
export interface IQDocStreamCallbacks {
  onStatus(status: string): void | Promise<void>
  onCalculatorResult(result: IQDocCalculatorResult): void | Promise<void>
}

export function createIQDocInterceptingFetch(
  baseFetch: typeof fetch,
  callbacks: IQDocStreamCallbacks,
): typeof fetch
```

Buffer decoded bytes until `\n\n`, normalize CRLF, parse every `data:` line,
extract the three IQdoc keys, and serialize a sanitized event. Drop an event
only when its delta has no standard keys after removal. Await callbacks so a
durable activity write completes before the provider stream advances.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test examples/agent-chat/src/agent/iqdoc.test.ts
```

Expected: all interceptor tests PASS with no warnings.

- [ ] **Step 5: Commit the interceptor**

```bash
git add examples/agent-chat/src/agent/iqdoc.ts examples/agent-chat/src/agent/iqdoc.test.ts
git commit -m "feat(agent-chat): parse IQdoc stream events"
```

### Task 2: IQdoc responder and provider selection

**Files:**

- Modify: `examples/agent-chat/src/agent/iqdoc.ts`
- Modify: `examples/agent-chat/src/agent/iqdoc.test.ts`
- Modify: `examples/agent-chat/src/agent/types.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Modify: `examples/agent-chat/src/agent/runtime.test.ts`
- Create: `examples/agent-chat/src/agent/provider.ts`
- Create: `examples/agent-chat/src/agent/provider.test.ts`
- Modify: `examples/agent-chat/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Adds: `AgentResponderInput.threadId: string`.
- Adds: `AgentResponderStream.writeActivity(input)` for one completed visible provider activity.
- Produces: `createIQDocResponder(options): AgentResponder`.
- Produces: `createConfiguredResponder(options): AgentResponder` with explicit `openai | iqdoc` selection.

- [ ] **Step 1: Write failing responder contract tests**

Add an injected fetch test that calls the real responder with a literal OpenAI
SSE fixture. Assert the captured request URL, headers, and body:

```ts
expect(request.url).toBe('https://iqdoc.example/api/v1/chat/completions')
expect(request.headers.get('X-Api-Key')).toBe('iqdoc-secret')
expect(request.headers.get('X-Chat-Id')).toBe(parseTypeId(threadId).uuid)
expect(request.headers.get('X-Message-Id')).toBe(parseTypeId(runId).uuid)
expect(JSON.parse(request.body).model).toBe('pubmed_assistant_fast')
expect(JSON.parse(request.body).tools).toBeUndefined()
expect(textDeltas.join('')).toBe('Clinical answer')
expect(activities).toEqual([
  { kind: 'status', title: 'Searching PubMed' },
  {
    kind: 'tool_call',
    title: 'BMI',
    output: { ok: true, calculator_id: 'bmi', name: 'BMI' },
  },
])
```

Add a test that an empty IQdoc key returns the deterministic demo responder.
Add provider-factory tests proving `provider: 'iqdoc'` selects IQdoc options
and `provider: 'openai'` preserves the current responder.

- [ ] **Step 2: Run responder tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/agent/iqdoc.test.ts examples/agent-chat/src/agent/provider.test.ts examples/agent-chat/src/agent/runtime.test.ts
```

Expected: FAIL because the IQdoc responder, provider factory, thread identity,
and generic activity observer do not exist.

- [ ] **Step 3: Install the matching OpenAI-compatible provider**

Run from the repository root:

```bash
bun add --cwd examples/agent-chat @ai-sdk/openai-compatible@^3.0.41
```

Expected: `examples/agent-chat/package.json` and `bun.lock` record the AI SDK 7
compatible package.

- [ ] **Step 4: Implement the responder and durable activity boundary**

Implement:

```ts
export interface AgentStreamActivity {
  kind: AgentRunStepKind
  title: string
  detail?: unknown
  output?: unknown
  visibility?: AgentRunStepVisibility
}
```

`runtime.ts` implements `writeActivity` by starting and immediately finishing
an `agentRunSteps` row. `writeStatus` delegates to it. Add `threadId` to both
normal-turn and commitment responder inputs.

`createIQDocResponder` constructs `createOpenAICompatible` inside the returned
responder so callbacks bind to the current durable stream. Normalize the base
URL, set `X-Api-Key`, enable usage, send parsed UUID headers through
`streamText`, omit tools/system envelopes, forward text deltas, and return the
usual completed checkpoint.

`createConfiguredResponder` uses IQdoc only for explicit `provider: 'iqdoc'`;
otherwise it delegates to the existing `createAIResponder`. Missing selected
provider credentials preserve the deterministic fallback.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test examples/agent-chat/src/agent/iqdoc.test.ts examples/agent-chat/src/agent/provider.test.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/model.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the responder boundary**

```bash
git add bun.lock examples/agent-chat/package.json examples/agent-chat/src/agent/iqdoc.ts examples/agent-chat/src/agent/iqdoc.test.ts examples/agent-chat/src/agent/provider.ts examples/agent-chat/src/agent/provider.test.ts examples/agent-chat/src/agent/types.ts examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/agent/runtime.test.ts
git commit -m "feat(agent-chat): add IQdoc responder"
```

### Task 3: Example configuration and recovery documentation

**Files:**

- Modify: `examples/agent-chat/src/env.ts`
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/.env.example`
- Modify: `examples/agent-chat/README.md`
- Modify: `examples/agent-chat/bunderstack.blueprint.yaml`
- Test: `examples/agent-chat/src/agent/provider.test.ts`
- Test: `examples/agent-chat/src/agent/recovery.test.ts`

**Interfaces:**

- Consumes: `createConfiguredResponder` from Task 2.
- Produces: environment contract `AI_PROVIDER`, `IQDOC_API_KEY`,
  `IQDOC_BASE_URL`, and `IQDOC_MODEL`.
- Preserves: current OpenAI-compatible and deterministic configuration.

- [ ] **Step 1: Write a failing configuration test**

Extend the provider test with the same plain options object built by the
Bunderstack helper and assert that simultaneous OpenAI and IQdoc credentials
select only the explicit provider. Verify IQdoc defaults to
`assistant_auto`, while existing AI configuration remains unchanged for
`openai`.

- [ ] **Step 2: Run provider and recovery tests and verify RED**

Run:

```bash
bun test examples/agent-chat/src/agent/provider.test.ts examples/agent-chat/src/agent/recovery.test.ts
```

Expected: the configuration assertion FAILS because the environment-to-provider
mapping is not connected.

- [ ] **Step 3: Wire both jobs through one responder helper**

Add optional environment entries with these defaults:

```ts
AI_PROVIDER: type("'openai' | 'iqdoc' | undefined").pipe(v => v ?? 'openai')
IQDOC_API_KEY: type('string | undefined')
IQDOC_BASE_URL: type('string | undefined')
IQDOC_MODEL: type('string | undefined').pipe(v => v ?? 'assistant_auto')
```

Create one local `responderFor(env)` helper in `bunderstack.ts` and use it for
both `agentTurn` and `agentCommitment`, removing the duplicated construction.
Document all eight model identifiers and the recovery boundary in README and
`.env.example`. Add the four variables to the blueprint as optional server
secrets/configuration, keeping the API key secret.

- [ ] **Step 4: Run focused and example verification**

Run:

```bash
bun test examples/agent-chat/src
bun run --cwd examples/agent-chat build
bun run typecheck:all
```

Expected: all agent-chat tests PASS, the example builds, and workspace type
checking succeeds.

- [ ] **Step 5: Commit configuration and documentation**

```bash
git add examples/agent-chat/src/env.ts examples/agent-chat/src/bunderstack.ts examples/agent-chat/.env.example examples/agent-chat/README.md examples/agent-chat/bunderstack.blueprint.yaml examples/agent-chat/src/agent/provider.test.ts
git commit -m "docs(agent-chat): configure IQdoc models"
```

### Task 4: Final regression verification

**Files:**

- Modify only files required by a newly reproduced regression.

**Interfaces:**

- Verifies the complete provider adapter against the approved spec.

- [ ] **Step 1: Run the complete agent-chat suite**

```bash
bun test examples/agent-chat/src
```

Expected: all tests PASS with no unhandled errors or warnings.

- [ ] **Step 2: Run static and build checks**

```bash
bun run typecheck:all
bun run --cwd examples/agent-chat build
```

Expected: both commands exit 0.

- [ ] **Step 3: Inspect the final diff and repository state**

```bash
git diff HEAD~3 --check
git status --short
```

Expected: no whitespace errors and only intentional files, with the design and
plan documents included in the final documentation commit if not committed
earlier.

- [ ] **Step 4: Optional live smoke test**

With user-supplied local secrets, set `AI_PROVIDER=iqdoc`, choose one IQdoc
model, run `bun run dev:agent-chat`, submit a medical query, disconnect and
reload the browser, and confirm statuses, calculator results, and answer text
reconstruct from database state. Never print or commit the secret.
