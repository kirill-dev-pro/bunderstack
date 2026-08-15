# Streaming Job Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background job in `examples/todo-solid-2` generates a summary for each todo one word at a time, streaming every word to the browser as a row update.

**Architecture:** Progress is projected onto the rows being changed rather than stored in a separate progress table. The job UPDATEs one row per todo, appending each generated word to a `summary` column and publishing `'update'` with the full accumulated text, so the row *is* the state and a reconnecting client needs no replay logic. The existing `jobRuns` table, `seedTodos` job, and `/api/seed` procedure are removed; the client derives progress by counting row statuses.

**Tech Stack:** Bun, Bunderstack, Drizzle (libSQL), valibot, Solid 2.0 RC, `@tanstack/solid-query@6`, `bunderstack-query`.

**Spec:** [docs/superpowers/specs/2026-08-15-solid-2-streaming-job-progress-design.md](../specs/2026-08-15-solid-2-streaming-job-progress-design.md)

## Global Constraints

- All commands run from the repo root `/Users/kirill/Projects/bunderstack-project/bunderstack` unless a step says otherwise.
- Use `bun`, never `node`/`npm`/`npx`. Tests are `bun test`.
- No new runtime dependencies. The fake generator uses no network and no API key.
- `summaryStatus` values are exactly `'idle' | 'queued' | 'streaming' | 'done' | 'failed'`.
- Word count per summary is 4–10 inclusive; delay between words is 40–200ms inclusive.
- Job handlers write through `ctx.db` and publish explicitly with `ctx.realtime.publish(table, action, row)` — `ctx.db` writes do NOT auto-publish.
- Drizzle `where(eq(todos.id, x))` needs `x as never` because `typeid('todo')` brands the column type. The existing `seedTodos` handler already does this.
- Run `bun run fix` (lint + format) before each commit.

## File Structure

| File | Responsibility |
| --- | --- |
| `examples/todo-solid-2/src/fake-llm.ts` | **Create.** Vocabulary + the three random-range helpers + `sleep`. No Bunderstack imports, so it is trivially testable. |
| `examples/todo-solid-2/src/fake-llm.test.ts` | **Create.** Range and membership tests for the generator. |
| `examples/todo-solid-2/src/bunderstack.ts` | **Modify.** Add `summary`/`summaryStatus` + `writableColumns`; add `enrichTodos` job and `/api/enrich`; remove `jobRuns`, `seedTodos`, `/api/seed`; export `todos` for tests. |
| `examples/todo-solid-2/src/enrich.test.ts` | **Create.** Access enforcement, trigger idempotency, and the streaming publish sequence. |
| `examples/todo-solid-2/src/provision.ts` | **Modify.** Seed three todos when the table is empty. |
| `examples/todo-solid-2/src/TodoList.tsx` | **Modify.** Drop the `jobRuns` query, derive progress from row statuses, render streamed summaries. |
| `examples/todo-solid-2/src/app.css` | **Modify.** Summary line, streaming cursor, failed state. |
| `examples/todo-solid-2/package.json` | **Modify.** Add a `test` script. |
| `examples/todo-solid-2/README.md` | **Modify.** Document the new job. |
| `docs/superpowers/specs/2026-08-14-solid-2-todo-example-design.md` | **Modify.** Files listing loses `jobRuns`. |

**Task ordering keeps the example working at every commit.** Columns are added before the job that writes them; the client stops referencing `jobRuns` before the server deletes it.

---

### Task 1: Server-owned summary columns

Adds the two columns and locks them against client writes. `jobRuns` and `seedTodos` are untouched, so the example still runs.

**Files:**
- Modify: `examples/todo-solid-2/src/bunderstack.ts`
- Test: `examples/todo-solid-2/src/enrich.test.ts` (create)
- Modify: `examples/todo-solid-2/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const todos` from `src/bunderstack.ts`, with columns `summary: string | null` and `summaryStatus: 'idle' | 'queued' | 'streaming' | 'done' | 'failed'`. Tasks 2–4 all depend on these names.

- [ ] **Step 1: Add a test script to the example**

In `examples/todo-solid-2/package.json`, add to `"scripts"`:

```json
"test": "bun test src/"
```

- [ ] **Step 2: Write the failing test**

Create `examples/todo-solid-2/src/enrich.test.ts`. The env vars must be set **before** importing `./bunderstack`, because that module creates the app at import time. `BUNDERSTACK_ROLE=web` stops a background worker from auto-starting, so job execution stays deterministic and driven by `app.jobs.tick()`.

```ts
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATABASE_URL = `file:${join(tmpdir(), `todo-solid-2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}`
process.env.BUNDERSTACK_ROLE = 'web'

const { app, todos } = await import('./bunderstack')
const { provision } = await import('bunderstack/provision')
await provision(app, { force: true })

async function createTodo(title: string) {
  const res = await app.handler(
    new Request('http://localhost/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
  // The generated create route answers 201, not 200.
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

test('summary columns are not writable through the CRUD route', async () => {
  const created = await createTodo('locked')

  const res = await app.handler(
    new Request(`http://localhost/api/todos/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'renamed',
        summary: 'injected',
        summaryStatus: 'done',
      }),
    }),
  )
  expect(res.status).toBe(200)

  const [row] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))

  // The allowlisted column took the write; the server-owned ones did not.
  expect(row!.title).toBe('renamed')
  expect(row!.summary).toBeNull()
  expect(row!.summaryStatus).toBe('idle')
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test --cwd examples/todo-solid-2 src/enrich.test.ts
```

Expected: FAIL. `todos` is not an export of `./bunderstack`, so the import throws.

- [ ] **Step 4: Add the columns and the allowlist**

In `examples/todo-solid-2/src/bunderstack.ts`, export the table and add the two columns:

```ts
export const todos = sqliteTable('todos', {
  id: typeid('todo')
    .primaryKey()
    .$defaultFn(() => generateTypeId('todo')),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),

  // Written only by the enrichTodos job. `summary` accumulates every word
  // generated so far, so the row carries the whole stream and a client that
  // reconnects mid-generation needs no replay.
  summary: text('summary'),
  summaryStatus: text('summaryStatus', {
    enum: ['idle', 'queued', 'streaming', 'done', 'failed'],
  })
    .notNull()
    .default('idle'),
})
```

In the same file's `access.todos` block, add the allowlist. Without it the two columns above would be writable through the generated PATCH route, because the default readonly set covers only `id`, `createdAt`, and `updatedAt`:

```ts
      todos: {
        crud: true,
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
        // An explicit allowlist: everything else on the table is server-owned.
        writableColumns: ['title', 'done'],
        sortableColumns: ['createdAt', 'done'],
        defaultSort: { column: 'createdAt', order: 'desc' },
      },
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test --cwd examples/todo-solid-2 src/enrich.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add examples/todo-solid-2/src/bunderstack.ts examples/todo-solid-2/src/enrich.test.ts examples/todo-solid-2/package.json
git commit -m "feat(example): add server-owned summary columns to todos"
```

---

### Task 2: The fake token generator

A standalone module so the job has nothing to mock and the ranges are testable on their own.

**Files:**
- Create: `examples/todo-solid-2/src/fake-llm.ts`
- Test: `examples/todo-solid-2/src/fake-llm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VOCABULARY: readonly string[]`, `randomWord(): string`, `summaryLength(): number` (4–10), `tokenDelay(): number` (40–200), `sleep(ms: number): Promise<void>`. Task 3 imports all but `VOCABULARY`.

- [ ] **Step 1: Write the failing test**

Create `examples/todo-solid-2/src/fake-llm.test.ts`. Each range is sampled repeatedly because the functions are random — a single call proves nothing.

```ts
import { expect, test } from 'bun:test'

import { randomWord, summaryLength, tokenDelay, VOCABULARY } from './fake-llm'

test('randomWord only ever returns a vocabulary entry', () => {
  for (let i = 0; i < 200; i++) {
    expect(VOCABULARY).toContain(randomWord())
  }
})

test('summaryLength stays within 4 and 10 inclusive', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 500; i++) {
    const n = summaryLength()
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(4)
    expect(n).toBeLessThanOrEqual(10)
    seen.add(n)
  }
  // A constant would pass the bounds check above, so assert it actually varies.
  expect(seen.size).toBeGreaterThan(1)
})

test('tokenDelay stays within 40 and 200 inclusive', () => {
  for (let i = 0; i < 500; i++) {
    const ms = tokenDelay()
    expect(ms).toBeGreaterThanOrEqual(40)
    expect(ms).toBeLessThanOrEqual(200)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd examples/todo-solid-2 src/fake-llm.test.ts
```

Expected: FAIL — cannot resolve `./fake-llm`.

- [ ] **Step 3: Write the module**

Create `examples/todo-solid-2/src/fake-llm.ts`:

```ts
/**
 * A stand-in for a streaming model.
 *
 * What this example demonstrates is what happens to a token *after* it exists
 * — how it reaches the browser — not where it came from. Generating words
 * locally keeps the example runnable with no API key, no network, and no
 * dependency, while producing the same bursty sub-second event pattern a real
 * model would.
 */
export const VOCABULARY = [
  'blocked',
  'decision',
  'draft',
  'estimate',
  'follow-up',
  'high-value',
  'low-effort',
  'needs',
  'quick',
  'review',
  'rough',
  'scope',
  'ship',
  'team',
  'waiting',
  'week',
] as const

/** One generated token. */
export function randomWord(): string {
  return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)]!
}

/** How many tokens this summary runs to. */
export function summaryLength(): number {
  return 4 + Math.floor(Math.random() * 7)
}

/** Milliseconds to wait before the next token. */
export function tokenDelay(): number {
  return 40 + Math.floor(Math.random() * 161)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd examples/todo-solid-2 src/fake-llm.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
bun run fix
git add examples/todo-solid-2/src/fake-llm.ts examples/todo-solid-2/src/fake-llm.test.ts
git commit -m "feat(example): add a keyless fake token generator"
```

---

### Task 3: The enrich job and its trigger

**Files:**
- Modify: `examples/todo-solid-2/src/bunderstack.ts`
- Test: `examples/todo-solid-2/src/enrich.test.ts`

**Interfaces:**
- Consumes: `todos` (Task 1); `randomWord`, `summaryLength`, `tokenDelay`, `sleep` (Task 2).
- Produces: job `enrichTodos` with input `{ ids: string[] }`; procedure `enrich` at `POST /api/enrich` returning `{ queued: number }`. Task 5's client calls `api.enrich.call({})`.

- [ ] **Step 1: Write the failing tests**

Append to `examples/todo-solid-2/src/enrich.test.ts`. The publish spy is the repo's established way to observe realtime without parsing SSE — `app.realtime` is the same facade job handlers receive, so job publishes land in the spy too.

```ts
import { spyOn } from 'bun:test'
import { getTableName } from 'drizzle-orm'

type Published = { table: string; action: string; record: Record<string, unknown> }

function capturePublishes(): Published[] {
  const events: Published[] = []
  spyOn(app.realtime, 'publish').mockImplementation(
    async (table, action, record) => {
      events.push({
        table: getTableName(table),
        action,
        record: record as unknown as Record<string, unknown>,
      })
    },
  )
  return events
}

async function enrich() {
  const res = await app.handler(
    new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { queued: number }
}

test('the trigger claims idle rows once', async () => {
  await createTodo('claim me')

  const first = await enrich()
  expect(first.queued).toBeGreaterThan(0)

  // Everything is `queued` now, so a second click finds nothing to claim and
  // cannot double-enqueue the same todos.
  const second = await enrich()
  expect(second.queued).toBe(0)
})

test('the job streams a growing summary and ends done', async () => {
  const created = await createTodo('stream me')
  await enrich()

  const events = capturePublishes()
  // One tick claims and runs every pending job, including the one the previous
  // test enqueued — the tests share a module-level app and database. Filtering
  // by row id below is what keeps this test's assertions about its own todo.
  await app.jobs.tick()

  const mine = events.filter(
    (e) => e.table === 'todos' && e.record.id === created.id,
  )

  // More than one publish for a single row is the whole point: the summary
  // arrives in pieces rather than in one final write.
  expect(mine.length).toBeGreaterThan(2)

  const texts = mine
    .map((e) => e.record.summary)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  expect(texts.length).toBeGreaterThan(1)
  for (let i = 1; i < texts.length; i++) {
    // Each publish carries the whole accumulated text, so it only ever grows
    // and every earlier value is a prefix of the next.
    expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true)
    expect(texts[i]!.length).toBeGreaterThan(texts[i - 1]!.length)
  }

  expect(mine.at(-1)!.record.summaryStatus).toBe('done')

  const [row] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))
  expect(row!.summaryStatus).toBe('done')
  expect(row!.summary!.split(' ').length).toBeGreaterThanOrEqual(4)
  expect(row!.summary!.split(' ').length).toBeLessThanOrEqual(10)
}, 20_000)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test --cwd examples/todo-solid-2 src/enrich.test.ts
```

Expected: FAIL — `POST /api/enrich` 404s, so `expect(res.status).toBe(200)` fails.

- [ ] **Step 3: Add the imports**

In `examples/todo-solid-2/src/bunderstack.ts`, extend the drizzle import and add the generator import. Delete the local `sleep` const — it now comes from `./fake-llm`:

```ts
import { and, eq, inArray, ne } from 'drizzle-orm'

import {
  randomWord,
  sleep,
  summaryLength,
  tokenDelay,
} from './fake-llm'
```

- [ ] **Step 4: Add the job**

Add `enrichTodos` inside the existing `jobs: (j) => j.define({ ... })` block, alongside `seedTodos` (which Task 6 removes):

```ts
        enrichTodos: j.job({
          input: v.object({ ids: v.array(v.string()) }),
          handler: async (input, ctx) => {
            for (const id of input.ids) {
              const [started] = await ctx.db
                .update(todos)
                .set({ summaryStatus: 'streaming' })
                .where(eq(todos.id, id as never))
                .returning()
              if (!started) continue
              await ctx.realtime.publish(todos, 'update', started)

              // The accumulated text is republished in full on every word, so
              // the row is the entire state of the stream. A client that drops
              // and refetches sees exactly what it missed, with no replay.
              let summary = ''
              const words = summaryLength()
              for (let i = 0; i < words; i++) {
                await sleep(tokenDelay())
                summary += (summary ? ' ' : '') + randomWord()
                const [row] = await ctx.db
                  .update(todos)
                  .set({ summary })
                  .where(eq(todos.id, id as never))
                  .returning()
                if (row) await ctx.realtime.publish(todos, 'update', row)
              }

              const [finished] = await ctx.db
                .update(todos)
                .set({ summaryStatus: 'done' })
                .where(eq(todos.id, id as never))
                .returning()
              if (finished) await ctx.realtime.publish(todos, 'update', finished)
            }
          },
          onFailed: async (input, _error, ctx) => {
            // Rows the handler never reached, or died part-way through, would
            // otherwise sit in the UI spinning forever.
            const rows = await ctx.db
              .update(todos)
              .set({ summaryStatus: 'failed' })
              .where(
                and(
                  inArray(todos.id, input.ids as never[]),
                  ne(todos.summaryStatus, 'done'),
                ),
              )
              .returning()
            for (const row of rows) {
              await ctx.realtime.publish(todos, 'update', row)
            }
          },
        }),
```

- [ ] **Step 5: Add the trigger procedure**

Add `enrich` to the `api: { ... }` object, next to `seed` (which Task 6 removes):

```ts
      enrich: o.public
        .route({ method: 'POST', path: '/api/enrich', tags: ['jobs'] })
        // An explicit empty input, so the generated client's call signature is
        // `call({})` rather than a no-argument call.
        .input(v.object({}))
        .output(v.object({ queued: v.number() }))
        .handler(async ({ context }) => {
          // Claiming here rather than in the handler makes the button reflect
          // reality immediately, and makes a second click a no-op instead of a
          // duplicate enqueue.
          const rows = await context.db
            .update(todos)
            .set({ summaryStatus: 'queued' })
            .where(eq(todos.summaryStatus, 'idle'))
            .returning()

          for (const row of rows) {
            await context.realtime.publish(todos, 'update', row)
          }
          if (rows.length > 0) {
            await context.jobs.enqueue('enrichTodos', {
              ids: rows.map((row) => row.id),
            })
          }
          return { queued: rows.length }
        }),
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test --cwd examples/todo-solid-2 src/enrich.test.ts
```

Expected: PASS, 3 tests. The streaming test takes several seconds by design — it is waiting on real 40–200ms delays.

- [ ] **Step 7: Commit**

```bash
bun run fix
git add examples/todo-solid-2/src/bunderstack.ts examples/todo-solid-2/src/enrich.test.ts
git commit -m "feat(example): stream generated summaries from a job"
```

---

### Task 4: Client renders the stream

The client stops referencing `jobRuns` here, *before* Task 6 deletes it, so no commit leaves the example broken.

**Files:**
- Modify: `examples/todo-solid-2/src/TodoList.tsx`
- Modify: `examples/todo-solid-2/src/app.css`

**Interfaces:**
- Consumes: `api.enrich.call({})` and the `summary`/`summaryStatus` columns.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the jobRuns query with derived progress**

In `examples/todo-solid-2/src/TodoList.tsx`, delete the `runs` query and the `active` helper, and replace the `seed` mutation:

```tsx
  const items = () => todos.data?.items ?? []

  // Progress is derived, not fetched. The run is the *claimed* set, so a todo
  // added mid-run stays `idle` and counts as neither finished nor outstanding.
  const claimed = () => items().filter((t) => t.summaryStatus !== 'idle')
  const settled = () =>
    claimed().filter(
      (t) => t.summaryStatus === 'done' || t.summaryStatus === 'failed',
    )
  const running = () => claimed().length > settled().length

  const enrich = useMutation(() => ({
    mutationFn: () => api.enrich.call({}),
  }))
```

- [ ] **Step 2: Drop jobRuns from the realtime subscription**

Same file — the summaries ride the `todos` subscription that already exists:

```tsx
  const realtime = syncRealtime<App>({
    api,
    queryClient: qc,
    tables: ['todos'],
    apply: 'patch',
  })
```

- [ ] **Step 3: Replace the jobs panel markup**

```tsx
      <div class="jobs">
        <button
          class="ghost"
          disabled={enrich.isPending || running() || items().length === 0}
          onClick={() => enrich.mutate()}
        >
          Summarise every todo
        </button>

        <Show when={running()}>
          <p class="run">
            <progress value={settled().length} max={claimed().length} />
            <span>
              summarising — {settled().length}/{claimed().length}
            </span>
          </p>
        </Show>
      </div>
```

- [ ] **Step 4: Render the summary on each row**

Replace the `<For each={todos.data!.items}>` body. The summary is a sibling of the label inside the `li`, and the CSS in Step 5 wraps it onto its own line:

```tsx
                {(todo) => (
                  <li class={{ done: todo.done }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onInput={(event) =>
                          toggle.mutate({
                            id: todo.id,
                            done: event.currentTarget.checked,
                          })
                        }
                      />
                      <span>{todo.title}</span>
                    </label>
                    <button
                      class="remove"
                      aria-label={`Delete ${todo.title}`}
                      onClick={() => remove.mutate(todo.id)}
                    >
                      ×
                    </button>
                    <Show when={todo.summaryStatus !== 'idle'}>
                      <p
                        class="summary"
                        classList={{
                          streaming: todo.summaryStatus === 'streaming',
                          failed: todo.summaryStatus === 'failed',
                        }}
                      >
                        {todo.summaryStatus === 'failed'
                          ? 'could not summarise'
                          : (todo.summary ?? '…')}
                      </p>
                    </Show>
                  </li>
                )}
```

Also update the list source to use the new helper — replace `todos.data!.items.length` with `items().length` and `each={todos.data!.items}` with `each={items()}`.

- [ ] **Step 5: Add the styles**

Append to `examples/todo-solid-2/src/app.css`:

```css
/* The summary sits on its own line beneath the title. */
.todos li {
  flex-wrap: wrap;
}

.summary {
  flex-basis: 100%;
  margin: 0.15rem 0 0 1.8rem;
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.4;
}

.summary.failed {
  color: var(--muted);
  font-style: italic;
}

/* A cursor while words are still arriving. */
.summary.streaming::after {
  content: '▍';
  margin-left: 0.15rem;
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}
```

The existing `.todos li` rule already sets `display: flex`; adding `flex-wrap: wrap` in a second rule is intentional so the original block stays untouched.

- [ ] **Step 6: Verify by hand**

```bash
bun run dev:todo-solid-2
```

Open `http://localhost:3006`, add two todos, click **Summarise every todo**. Confirm words appear one at a time under each title, the cursor blinks only on the row currently streaming, and the progress bar advances per todo. Leave the tab open — the rows must keep updating without a manual refresh.

- [ ] **Step 7: Commit**

```bash
bun run fix
git add examples/todo-solid-2/src/TodoList.tsx examples/todo-solid-2/src/app.css
git commit -m "feat(example): render streamed summaries and derived progress"
```

---

### Task 5: Prove the fine-grained update claim

The spec claims a word arriving for one todo updates one text node and leaves the other rows alone. That is the example's actual assertion about Solid, so it gets checked rather than asserted.

**Files:**
- Modify: `examples/todo-solid-2/src/TodoList.tsx` (temporarily)

**Interfaces:**
- Consumes: Task 4's rendering.
- Produces: nothing — this task's output is a verified claim and a README sentence in Task 7.

- [ ] **Step 1: Add a temporary render counter**

In `TodoList.tsx`, wrap the `<For>` callback body in a block so a log statement can run once per row *creation*. Task 4 Step 4 left the callback as `{(todo) => ( <li …>…</li> )}`; change only the two lines around the existing `<li>` — the markup inside it is untouched:

```tsx
                {(todo) => {
                  console.log('row created', todo.id)
                  return (
                    <li class={{ done: todo.done }}>
```

and close it at the end of the callback:

```tsx
                    </li>
                  )
                }}
```

- [ ] **Step 2: Observe**

```bash
bun run dev:todo-solid-2
```

Add three todos, open the browser console, clear it, then click **Summarise every todo**.

Expected: `row created` does **not** log during streaming. `<For>` keys by reference and the store reconciles the patched array, so rows are not recreated even though `queryClient.setQueryData` hands over a fresh array on every word.

If rows *are* recreated, the cause is almost certainly `apply: 'patch'` replacing row objects wholesale. Record the finding and stop — do not paper over it; it invalidates the spec's "What Solid contributes" section and needs a decision.

- [ ] **Step 3: Remove the counter**

Revert Step 1 entirely. `git diff` must show no change to `TodoList.tsx`.

- [ ] **Step 4: Commit (nothing to commit)**

```bash
git status --short examples/todo-solid-2/src/TodoList.tsx
```

Expected: empty output. This task produces no commit; its result is recorded in Task 7's README.

---

### Task 6: Remove jobRuns, seedTodos, and /api/seed

Nothing references them after Task 4, so this is a clean deletion.

**Files:**
- Modify: `examples/todo-solid-2/src/bunderstack.ts`
- Modify: `examples/todo-solid-2/src/provision.ts`

**Interfaces:**
- Consumes: Task 4's client (no longer queries `jobRuns`).
- Produces: `provision.ts` seeds three todos on an empty table, replacing what `seedTodos` did.

- [ ] **Step 1: Delete the server pieces**

From `examples/todo-solid-2/src/bunderstack.ts`, remove:

1. The entire `jobRuns` table definition and its doc comment.
2. `jobRuns` from `const schema = { ...internal, todos, jobRuns }` → `const schema = { ...internal, todos }`.
3. The whole `jobRuns: { ... }` entry in `access`.
4. The whole `seedTodos: j.job({ ... })` entry in `jobs`.
5. The whole `seed: o.public...` entry in `api`.

Two comments in that file describe the deleted code and must be rewritten:

- Above the `api:` key, `// One custom procedure: create the run row, then queue the work.` becomes `// One custom procedure: claim the idle rows, then queue the work.`
- The `jobRuns` doc comment ("A background job's progress, as an ordinary row.") goes with the table.

Then confirm no stale identifier survives:

```bash
grep -n "jobRuns\|seedTodos\|/api/seed" examples/todo-solid-2/src/*.ts examples/todo-solid-2/src/*.tsx
```

Expected: no output.

- [ ] **Step 2: Seed from provision instead**

In `examples/todo-solid-2/src/provision.ts`, replace the final two lines (`await provision(app)` / `await app.close()`) with:

```ts
import { provision } from 'bunderstack/provision'

import { app, todos } from './bunderstack'

await provision(app)

// A fresh database has nothing to summarise, and the summarise button is
// disabled on an empty list. `seedTodos` used to fill this gap; a startup
// insert is cheaper than keeping a job for it.
const existing = await app.db.select({ id: todos.id }).from(todos).limit(1)
if (existing.length === 0) {
  await app.db
    .insert(todos)
    .values([
      { title: 'Read the Solid 2 release notes' },
      { title: 'Try the summarise button' },
      { title: 'Open a second tab and watch it stream' },
    ])
}

await app.close()
```

- [ ] **Step 3: Rebuild the local database**

`jobRuns` still exists in the checked-out `data.db`, and the example is a demo whose local database is disposable:

```bash
rm -f examples/todo-solid-2/data.db
bun run --cwd examples/todo-solid-2 provision
```

Expected: exits 0.

- [ ] **Step 4: Run the full example test suite**

```bash
bun test --cwd examples/todo-solid-2
```

Expected: PASS, 6 tests across two files.

- [ ] **Step 5: Verify by hand**

```bash
bun run dev:todo-solid-2
```

Expected: three seeded todos on first load, and the summarise button works exactly as in Task 4.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add examples/todo-solid-2/src/bunderstack.ts examples/todo-solid-2/src/provision.ts
git commit -m "refactor(example): replace jobRuns and seedTodos with row-level progress"
```

---

### Task 7: Documentation and full verification

**Files:**
- Modify: `examples/todo-solid-2/README.md`
- Modify: `docs/superpowers/specs/2026-08-14-solid-2-todo-example-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the base spec's Files listing**

In `docs/superpowers/specs/2026-08-14-solid-2-todo-example-design.md`, the Files block line for `src/provision.ts` currently reads `provision(app), run by dev and start before serving`. Change it to:

```
  src/provision.ts      provision(app) + first-run seed, run by dev and start
  src/fake-llm.ts       the stand-in token generator
```

- [ ] **Step 2: Document the job in the example README**

In `examples/todo-solid-2/README.md`, replace the whole `## Background jobs, watched live` section — everything from that heading down to (but not including) `## Files`, which is lines 140–181 at the time of writing and describes `seedTodos`, `jobRuns`, and `api.seed` — with:

````markdown
## Streaming job progress

Click **Summarise every todo** and a background job generates a summary for
each row one word at a time.

There is no progress channel and no progress table. Bunderstack's only realtime
event is "a row changed", so the job simply writes:

```ts
summary += (summary ? ' ' : '') + randomWord()
const [row] = await ctx.db.update(todos).set({ summary })
  .where(eq(todos.id, id as never)).returning()
await ctx.realtime.publish(todos, 'update', row)
```

Each publish carries the whole accumulated text, so the row *is* the state of
the stream — open a second tab mid-run, or refresh, and it picks up exactly
where the first left off with no replay logic.

Progress is derived the same way. `summaryStatus` moves `idle → queued →
streaming → done` (or `failed`), and the client counts rows rather than
reading a run record.

`summary` and `summaryStatus` are server-owned: `writableColumns: ['title',
'done']` in the access rules means the generated PATCH route silently drops
client writes to them, while realtime still streams them to every client
allowed to read the row.

The generator in `src/fake-llm.ts` is deliberately fake — no API key, no
network. What the example demonstrates is what happens to a token after it
exists.
````

Note: `bun run dev` on this example uses port 3006.

- [ ] **Step 3: Typecheck the example**

```bash
bunx tsc --noEmit -p examples/todo-solid-2/tsconfig.json
```

Expected: no errors. If `tsc` cannot resolve `bunderstack/*`, run `bun run build` first — the example resolves the workspace package through its build output.

- [ ] **Step 4: Confirm nothing in the framework regressed**

The example is the only thing that changed, but it exercises access rules, jobs, and realtime:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Verify the production build**

```bash
bun run --cwd examples/todo-solid-2 build
```

Expected: exits 0 and writes `.output/server/index.mjs`.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add examples/todo-solid-2/README.md docs/superpowers/specs/2026-08-14-solid-2-todo-example-design.md
git commit -m "docs(example): document streaming job progress"
```

---

## After the plan

The spec's [What this measures](../specs/2026-08-15-solid-2-streaming-job-progress-design.md#what-this-measures) section is the point of building this. Once Task 7 lands, note two observations before deciding anything about per-table realtime opt-in or a non-table event channel:

1. With several browser tabs open on the example, does the filter work per connection show up at all? Every open SSE connection filters the whole `change` topic in userland.
2. Is one SQL UPDATE per word noticeable in the dev log?

Neither question is answered by this plan. It exists so the answers come from numbers instead of speculation.
