# Live views

One SSE stream per list query: a snapshot of the result, then the changes that
belong to that result, decided on the server. A client keeps the view current
without a cache, without invalidation, and without a refetch after a reconnect.

Scope is `packages/bunderstack`: a new procedure beside the CRUD procedures, a
narrowed input contract, a per-connection window, and a new browser-safe
subpath `bunderstack/live`. The existing `/api/realtime` subscription endpoint
does not change.

The idea comes from the branch `feat/solid-native-backend`, where it was built
against Solid 2. Nothing in the contract needs Solid. This design ports the
idea, keeps the parts that carry their weight, and repairs the defects the
review of that branch found.

## Why

Today a list view needs three moving parts on the client: a query cache, an
invalidation rule per mutation, and a refetch path for reconnects. The client
also decides which streamed change belongs to which view, so every application
re-implements the server's filter rules in the browser.

A live view moves that decision to the server. The server knows the filters, the
sort, and the window, so it can say what a change means for one view: add this
row here, drop that row, or nothing at all. The client applies frames in order
and holds no second copy of the data.

The recovery story gets shorter as well. Every connection starts with a
snapshot, so a reconnect _is_ the resynchronisation. There is no event buffer,
no `Last-Event-ID` bookkeeping, and no "refetch after a gap" branch.

## Decisions

| Decision        | Choice                                                         | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path shape      | `GET /api/live/{table}`                                        | A path of its own is the only shape without a collision. `/{table}/live` shadows the id `"live"` on `/{table}/{id}`. `?live=1` is impossible: two GET procedures on one path leave the second unreachable, and one procedure cannot declare a union of a JSON output and an `eventIterator`, so `list` would lose its response type. A colon suffix (`/{table}:live`) is worse still — the oRPC matcher reads `:live` as a wildcard parameter, so `/api/postsXY` matches it. All three were verified on `@orpc/*` 2.0.0-beta.26. |
| Row placement   | Server sends `afterId` on every upsert                         | The client never repeats `ORDER BY`. No comparator, no null rules, no collation guesswork in the browser.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Window repair   | Server re-sends `snapshot`                                     | A removal inside a full window must pull one row in from below. A fresh snapshot is one code path instead of a second frame type, and the client already replaces the view on a snapshot.                                                                                                                                                                                                                                                                                                                                        |
| Access rule     | `list` right plus `readScope`, for the snapshot and the deltas | The caller asked for a list. Checking deltas with the `get` right, as the branch did, lets a table deliver a snapshot and then silently deliver nothing.                                                                                                                                                                                                                                                                                                                                                                         |
| Input contract  | List contract without `q`, `offset`, and `cursor`              | Only equality-style filters can be decided against one streamed record. Text search and pagination cannot.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Client core     | New subpath `bunderstack/live`, zero runtime dependencies      | The wire types stay next to the server that emits them. A browser bundle of this subpath must not reach server code.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Client bindings | None in this work                                              | The core exposes a `subscribe` / `getSnapshot` pair, which React consumes through `useSyncExternalStore` and Solid through a store write. A framework adapter can follow when an example needs one.                                                                                                                                                                                                                                                                                                                              |

## The wire contract

`GET /api/live/{table}` accepts `limit`, `sort`, `order`, and `filters`, with the
same meaning and the same coercion as `GET /api/{table}`. It answers
`text/event-stream` with these frames:

```ts
type LiveFrame =
  | {
      type: 'snapshot'
      items: Record<string, unknown>[]
      sort: string
      order: 'asc' | 'desc'
      limit: number
      hasMore: boolean
    }
  | { type: 'upsert'; record: Record<string, unknown>; afterId: string | null }
  | { type: 'remove'; id: string }
  | { type: 'heartbeat'; intervalMs: number }
```

`snapshot` replaces the view. It reports the values the server resolved, not the
values the caller sent, so a client that omits `sort` still learns the effective
order. `hasMore` says whether rows exist below the window.

`upsert` inserts or replaces one row. `afterId` names the row it follows;
`null` means the head of the view. A client that holds the row already must
remove it first and then insert it at the anchor, because an update can move a
row.

`remove` drops one row by id. A `remove` for an unknown id is a no-op, which is
what lets the server answer "this row left your view" and "this row was deleted"
with one frame.

`heartbeat` is unchanged from the existing realtime stream.

## Server design

### The live procedure

`buildTableCrudProcedures` gains a sixth procedure, built only when realtime is
on. It subscribes to the publisher **before** it reads the snapshot, so a change
that lands during the query waits in the publisher and replays on the first
pull.

The handler holds one `LiveWindow` per connection. The snapshot fills it; each
change asks it what the view must do.

### The window

`LiveWindow` is the whole server-side state of one connection: the ordered ids
of the rows in the window, the sort value of each row, `limit`, `sort`,
`order`, and `hasMore`. It answers one question — what does this change mean
for this view? — and returns one of:

- `{ type: 'none' }` — the change is outside the window and does not disturb it.
- `{ type: 'frames', frames }` — one `upsert` frame carrying its `afterId`, plus
  a trailing `remove` when a full window evicts its last row, or one `remove`
  when the row left the view.
- `{ type: 'resnapshot' }` — the window lost a row while rows exist below it.

`resnapshot` re-runs the same list query and emits a fresh `snapshot`. It
happens only when `hasMore` is true, so a view that fits inside its limit never
pays for a query.

The window compares sort values in the process, on the raw column values, not on
JSON. That is exact for numbers, dates, and booleans, and matches the database
for ordinary text. A collation that differs from code-unit order can place a row
inside the window differently from the database, as can a NULLS rule other than
"nulls first"; the window still holds the right rows, and the module's own
comment says so.

### Membership and access

`matchesLiveFilters` decides membership from the record alone, with the same
rules the list endpoint uses in SQL: a scalar is `=`, an array is `IN`, `null`
is `IS NULL`.

Access is one guard shared by the snapshot and the deltas: the `list` right of
the table plus `readScope` against the row. `filter.ts` grows
`createChangeGuard` (one table entry, one cached session) and
`filterTableChanges` (one table). `filterRealtimeChanges` keeps its current
behaviour and is rewritten on top of the shared guard.

## Client core (`bunderstack/live`)

```ts
import { createLiveView } from 'bunderstack/live'

const view = createLiveView<Todo>('/api/live/todos', {
  input: { sort: 'createdAt', order: 'desc', limit: 100 },
})

view.subscribe(() => render(view.getRows(), view.getStatus()))
// Optimistic: replace the row, so identity comparisons see the change.
view.patch((rows) => {
  rows[0] = { ...rows[0]!, done: true }
})
view.close()
```

- `getRows()` returns an immutable array. A new array appears only when the view
  changes, so `useSyncExternalStore` is satisfied without a wrapper.
- `getStatus()` is `'connecting' | 'live' | 'reconnecting' | 'failed'`, plus
  `getError()`. The status is `'reconnecting'` while rows are still on screen and
  `'failed'` only when there is nothing to show. The branch reported an error on
  every transient drop; this separates the two.
- `patch(recipe)` applies an optimistic write to the rows and notifies. The
  server echo replaces it. There is no rollback: `resync()` reconnects, and the
  snapshot is the truth.
- `close()` stops the loop and aborts the request. `resync()` aborts and
  reconnects.
- Reconnect uses full-jitter backoff, the same shape as
  `packages/bunderstack-query/src/realtime.ts`.

The module has no dependency on a framework, on the server package, or on
`@orpc/*`. It parses SSE itself, which is about forty lines.

Exported pieces: `createLiveView`, `applyLiveFrame` (the pure fold), the frame
types, and `parseSseFrames`.

## Testing

Server, with `bun test` in `packages/bunderstack`:

- `live-view.test.ts` — `matchesLiveFilters` and the change projection, per
  filter form.
- `live-window.test.ts` — the window: insert at head, middle, tail; a move; an
  eviction from a full window; a removal with and without `hasMore`; a change
  outside the window.
- `live-router.test.ts` — end to end over `OpenAPIHandler`: the path resolves
  next to `/{table}/{id}`, the snapshot reports resolved values, an in-view
  update arrives as `upsert` with the right `afterId`, an update that leaves the
  view arrives as `remove`, a foreign table is silent, and a table without a
  publisher has no live procedure.
- Access: a table whose `list` right denies the caller yields neither snapshot
  nor deltas.

Client:

- `apply.test.ts` — the pure fold against every frame.
- `live-view.test.ts` — the loop against a fake stream: snapshot then frames,
  a mid-stream failure and its reconnect, `patch` visibility, `close`.
- `scripts/bundle-boundaries.test.ts` — `bunderstack/live` bundles under 8 KB
  and contains no server code, no `drizzle-orm`, and no `better-auth`.

## Out of scope

- The OpenAPI client generator from `feat/solid-native-backend`. It is a
  separate experiment and stays on that branch.
- Framework adapters for React and Solid.
- Rewriting an example on live views. The contract lands first.
- `q`, `offset`, and `cursor` on a live view.
