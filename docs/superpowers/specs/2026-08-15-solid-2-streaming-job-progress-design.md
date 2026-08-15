# Streaming job progress in the Solid 2 example

A background job that generates a summary for each todo one word at a time,
streaming every word to the browser as it lands. Progress lives on the rows
being changed, not in a separate progress table.

Extends `examples/todo-solid-2`. The base example is specified in
[2026-08-14-solid-2-todo-example-design.md](./2026-08-14-solid-2-todo-example-design.md);
that document's decision table still says the example carries no jobs or
realtime, which the implementation has since outgrown.

## Why

The example already proves a job can report progress: `seedTodos` writes to a
`jobRuns` row and publishes the change, and the UI renders a `<progress>` bar
from it. That answers the coarse case — a job with a known step count and
nowhere to hang its state.

It does not answer the interesting one. Bunderstack's only realtime event is
"a row changed" (`RealtimeFacade.publish` takes a Drizzle table, an action, and
a record), so a job with something to say more than once per second has no
obvious place to say it. Whether that is a real limitation or just an unusual
way to spell "write to a table" is the question this example settles.

Simulated token generation is the right load for it: bursty, sub-second, and
unbounded in count, but with a natural row to attach to.

## Decisions

| Decision        | Choice                                     | Reason                                                                                                                |
| --------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| The job         | Enrich existing todos with a fake summary  | Streams tokens, and the rows it changes are already on screen and already subscribed.                                 |
| Generation      | Random words at random intervals, no LLM   | The example runs with no API key and no network. The realtime story is identical either way.                          |
| Progress model  | Status column on `todos`                   | The job transforms rows that already exist, so status belongs on them. No join, no extra subscription.                |
| `jobRuns`       | Deleted, along with `seedTodos`            | Two progress models in one ~170-line component teaches neither. The row-status model is the one that shows streaming. |
| Accumulation    | Full text in the row, republished per word | The row is the state, so a client that reconnects mid-stream needs no replay logic.                                   |
| Empty first run | Seed three todos from `provision.ts`       | `seedTodos` was what filled a fresh database; a startup insert is cheaper than keeping a job for it.                  |

### Why not a token per row

An events table with one row per word makes the row count unbounded, makes
reconnect a replay problem, and makes the client reassemble text from an
ordered scan. Accumulating in one row per todo costs write amplification
instead, which is bounded by the word count and invisible at demo scale.

### Why not a non-table event channel

Adding `ctx.realtime.emit(channel, payload)` would avoid the writes entirely,
but it needs an access-control story for channels that the table-keyed model
gets for free, and it drops persistence, which is what makes reconnect trivial
here. Building the example on today's primitives first is what will tell us
whether that cost is worth paying — see [What this measures](#what-this-measures).

## Schema

`jobRuns` is removed. `todos` gains two server-owned columns:

```ts
const todos = sqliteTable('todos', {
  // …id, title, done, createdAt unchanged
  summary: text('summary'),
  summaryStatus: text('summaryStatus', {
    enum: ['idle', 'queued', 'streaming', 'done', 'failed'],
  })
    .notNull()
    .default('idle'),
})
```

`summary` is null until the first word lands, then holds every word generated
so far. `summaryStatus` projects the job's state onto each row it touches:

| Status      | Set by                | Meaning                                    |
| ----------- | --------------------- | ------------------------------------------ |
| `idle`      | column default        | Never enriched.                            |
| `queued`    | `POST /api/enrich`    | Claimed by a job that has not reached it.  |
| `streaming` | the handler, per todo | Words are landing now.                     |
| `done`      | the handler, per todo | Finished.                                  |
| `failed`    | `onFailed`            | The job died before reaching or finishing. |

Every state `jobRuns` carried survives, counted off the rows instead of stored
separately.

## Access

`todos` is `update: 'public'`, and the default readonly list covers only
`id`, `createdAt`, and `updatedAt`. Adding the columns without a change would
let any client PATCH its own `summary` and `summaryStatus` through the
generated CRUD route.

```ts
todos: {
  crud: true,
  // …rules unchanged
  writableColumns: ['title', 'done'],
}
```

`writableColumns` is an explicit allowlist, so the new columns become readable
over CRUD and realtime and writable only by the job. Realtime needs nothing
further: the subscription filter reuses each table's CRUD read rule, so
`summary` streams to exactly the clients allowed to read the row.

## The job

```ts
enrichTodos: j.job({
  input: v.object({ ids: v.array(v.string()) }),
  handler: async (input, ctx) => {
    for (const id of input.ids) {
      await setStatus(ctx, id, 'streaming')

      let summary = ''
      for (let i = 0; i < 4 + Math.floor(Math.random() * 7); i++) {
        summary += (summary ? ' ' : '') + randomWord()
        const [row] = await ctx.db
          .update(todos)
          .set({ summary })
          .where(eq(todos.id, id as never))
          .returning()
        if (row) await ctx.realtime.publish(todos, 'update', row)
        await sleep(40 + Math.random() * 160)
      }

      await setStatus(ctx, id, 'done')
    }
  },
  onFailed: async (input, _error, ctx) => {
    // Rows the handler never reached, or was mid-way through, are not left
    // spinning in the UI.
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
    for (const row of rows) await ctx.realtime.publish(todos, 'update', row)
  },
})
```

Writing through `ctx.db` bypasses the generated CRUD routes, so each broadcast
is explicit — the same shape the existing `seedTodos` handler uses.

Words come from a fixed vocabulary in the example's own module. No network, no
key, no dependency.

### The trigger

```ts
enrich: o.public
  .route({ method: 'POST', path: '/api/enrich', tags: ['jobs'] })
  .handler(async ({ context }) => {
    const rows = await context.db
      .update(todos)
      .set({ summaryStatus: 'queued' })
      .where(eq(todos.summaryStatus, 'idle'))
      .returning()
    for (const row of rows) await context.realtime.publish(todos, 'update', row)
    if (rows.length)
      await context.jobs.enqueue('enrichTodos', { ids: rows.map((r) => r.id) })
    return { queued: rows.length }
  })
```

Claiming rows in the procedure rather than the handler means the button
reflects reality immediately, and a second click finds nothing claimable
instead of double-enqueueing the same todos.

> **Revised after use.** The claim was originally `where summaryStatus =
'idle'`, which made the button go dead once every row had a summary —
> `queued: 0`, no feedback, nothing to click. It now claims every row that is
> not `queued` or `streaming` and clears `summary` at claim time, so the button
> always re-summarises and the rerun streams from empty rather than mutating
> under a stale sentence. Rows already in flight are still excluded, which is
> what preserves the double-click guard.

## Client

No new subscription. `syncRealtime` already passes `tables: ['todos']`, and
`jobRuns` drops out of both the tables list and its own `useQuery`.

Progress is derived rather than fetched:

```ts
const items = () => todos.data?.items ?? []
// The run is the claimed set, not the whole list: a todo added mid-run stays
// `idle` and must not count as either finished or outstanding.
const claimed = () => items().filter((t) => t.summaryStatus !== 'idle')
const settled = () =>
  claimed().filter(
    (t) => t.summaryStatus === 'done' || t.summaryStatus === 'failed',
  )
const running = () => claimed().length > settled().length
```

The `<progress>` bar stays, shown while `running()`, with
`value={settled().length}` and `max={claimed().length}`. Each todo renders its
`summary` beneath the title, with a cursor while `streaming` and an inline
retry affordance while `failed`.

### What updates, and what does not — measured

The original design claimed a word arriving for todo #3 would update one text
node and leave every other row's DOM untouched. A render counter on the list
rows, run against a live stream, showed that is only half true.

**What actually happens:** rows the job is not touching are never recreated —
across a full run only the enriched rows churned, and the untouched ones logged
nothing. But each streaming row's entire `<li>` is torn down and rebuilt on
every token, roughly twelve times per todo.

The cause is in `bunderstack-query`, not in Solid. The patch path replaces the
matched row wholesale:

```ts
// packages/bunderstack-query/src/realtime.ts
items: items.map((item) => (sameValue(item['id'], id) ? change.record : item))
```

`change.record` is a fresh object off the SSE payload, and `<For>` keys by
reference, so a new object means a new row. Untouched rows keep their identity
through the `: item` branch, which is exactly why they survive.

So the honest claim is narrower than the original: **a write costs one row's
DOM, not the list's.** That is still the property worth showing — it is what
separates this from a framework that diffs the whole list on every token — but
it is not per-text-node updating, and the example should not say it is.

Making the stronger claim true means preserving row identity in the patch path
so `<For>` keeps the DOM and only the changed field updates. That is a
framework change with its own tests, deliberately not made here: see
[What this measures](#what-this-measures), where it now sits as the
best-evidenced of the three candidates.

## Error handling

- **Job dies mid-stream** — `onFailed` marks every non-`done` row `failed` and
  publishes, so nothing is left spinning.
- **Client disconnects mid-stream** — the row holds the full accumulated text,
  so a refetch on reconnect is exact. `syncRealtime` also resumes from the
  publisher's buffer, making the refetch usually unnecessary.
- **Double enqueue** — the `idle` filter in the trigger claims rows atomically;
  a concurrent second request queues nothing.
- **Retry** — the job's default retry policy re-runs the handler from the first
  id. Summaries are overwritten, not appended to, so a retry is idempotent per
  row.

## Testing

The example is a demo, so the tests cover the two things a reader would copy
and the one thing that would silently break:

1. **Access** — a PATCH to `/api/todos/:id` setting `summary` or
   `summaryStatus` is rejected. This is the security-relevant assertion.
2. **Trigger** — calling `/api/enrich` twice queues rows once.
3. **Streaming** — driving the worker with `app.jobs.tick()` produces multiple
   `update` publishes per todo with monotonically growing `summary`, and a
   terminal `done`.

Framework tests stay where they are; these live with the example.

## What this measures

At roughly eight words across ten todos, one run emits ~100 publishes in a few
seconds. Each is fanned out to every open SSE connection and filtered in
userland, per connection, against the whole `change` topic — including
connections that never subscribed to `todos`.

Three framework questions ride on how that behaves. The example was built first
precisely so these get decided against observations rather than speculation,
and one of them now has an answer:

- **Row identity in the patch path.** _Evidenced._ Replacing the matched row
  with the incoming record rebuilds that row's DOM on every event — measured at
  roughly twelve rebuilds per todo during a stream (see
  [What updates, and what does not](#what-updates-and-what-does-not--measured)).
  Merging into the existing object instead would make every high-frequency
  consumer cheaper, not just this example. This is the strongest of the three.
- **Per-table realtime opt-in.** _Not yet evidenced._ Realtime read access
  already tracks CRUD read access per table and per row, so this is not a leak.
  What cannot be expressed is "readable over CRUD, not subscribable", and the
  cost of the gap is filter work proportional to connections × total event
  rate. Nothing observed at this example's scale makes that visible.
- **A non-table event channel.** _Not yet evidenced._ One SQL UPDATE per word
  is real write amplification, but it did not show up as a problem at demo
  scale. If it hurts before the fan-out does, the answer is an event channel
  rather than an access flag.

None is designed here.
