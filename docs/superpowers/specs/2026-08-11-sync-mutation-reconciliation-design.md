# Sync mutation reconciliation — mutation response as source of truth

**Date:** 2026-08-11
**Status:** Implemented in `bunderstack-sync` 0.17.0-beta.0
**Package:** `packages/bunderstack-sync`

## Goal

Every successful CRUD mutation in a `createTableCollection` collection triggers
a full re-fetch of the table. The reference case is the tldraw example's
presence cursors: moving the mouse across a canvas produces a burst of
`POST /api/rpc/presence/list` requests, one per cursor update, on top of the
`PATCH` that carried the update.

The cause is a contract in `@tanstack/query-db-collection` 1.1.0. Its wrappers
around the mutation handlers (`src/query.ts:2037-2077`) treat a handler that
returns nothing as a handler whose result is unknown, and compensate with a
refetch:

```js
const handlerResult = (await onUpdate(params)) ?? {}
const shouldRefetch = handlerResult.refetch !== false
if (shouldRefetch) await refetch()
```

`collection.ts`'s `onInsert`, `onUpdate` and `onDelete` all return `void`, so
every mutation takes that branch. The refetch is not wrong — without it the
synced store would still hold the pre-mutation row when TanStack DB discards
the optimistic state — but it is the most expensive way to obtain a value the
server already returned in the mutation response.

The presence table makes the cost visible because it writes often. It is not a
presence-specific problem: the same doubling applies to every table, and the
20-second presence heartbeat pays it too.

A second cost is structural. At 8 cursor updates per second per user, even one
request each is 8 database writes and 8 broadcasts per user per second, with no
coalescing — the throttle in the example app spaces requests by a fixed 120 ms
regardless of what the network is doing. A sync library that markets optimistic
realtime collections should absorb that itself rather than push a magic
constant into every application.

Both are fixed in `bunderstack-sync`. The tldraw example is not modified; it
gets faster because the library does.

## Design

### A. Mutation response as source of truth

The handlers write the server's canonical row into the synced store themselves
and declare the refetch unnecessary:

```ts
onUpdate: async ({ transaction }) => {
  for (const mutation of transaction.mutations) {
    const row = await table.update.call({ ... })
    applyRealtimeEvent('update', row as Record<string, unknown>)
  }
  return { refetch: false }
}
```

Three properties of this shape matter and are not obvious.

**Ordering.** The `writeUpsert` must happen before the handler returns.
TanStack DB drops optimistic state once the transaction is marked persisted,
which happens after the handler resolves. Writing inside the handler guarantees
the synced store is already current at that moment, so the row never flickers
back to its pre-mutation value.

**Fan-out.** The handlers route through the existing `applyRealtimeEvent`, not
a bare `collection.utils.writeUpsert`. That function already fans a record out
to the base collection plus every registered scoped/byIds view, and already
issues a `writeDelete` when a row leaves a view's filter. Reusing it means
local mutations and remote broadcasts reconcile through one code path.

**Batched transactions.** `transaction.mutations[0]!` silently drops every
mutation after the first. Today the subsequent refetch papers over the
resulting drift. Removing the refetch removes the cover, so iterating over all
mutations is a required part of this change, not incidental cleanup.

**Insert with a server-assigned id.** When an application restricts
`writableColumns` so the server ignores the client-supplied `id`, the
optimistic row stays keyed under the client id and `writeUpsert` of the server
row cannot remove it. That case returns `{}` and takes the normal refetch. It
costs one extra request in an uncommon configuration and keeps it correct.

### B. In-flight update coalescing

A new module, `packages/bunderstack-sync/src/update-queue.ts`: pure logic, no
TanStack dependency, unit-testable on its own. `collection.ts` wires it into
`onUpdate`.

Each row key gets a single-slot queue:

```ts
{ changes: Record<string, unknown>, waiters: Deferred[], running: boolean }
```

`onUpdate` for key K merges `mutation.changes` into the slot (shallow merge,
last-write-wins per field), pushes its own deferred onto `waiters`, starts the
drain loop for K if it is not already running, and awaits its deferred.

The drain loop takes `changes` and `waiters` as **one snapshot**, empties the
slot, sends the request, writes the response through `applyRealtimeEvent`,
resolves the snapshotted waiters, and repeats if new changes accumulated during
the flight. An empty slot deletes the queue and ends the loop.

The snapshot gives the critical property for free: a waiter is always in the
same batch as its own changes, so it resolves only after a request that carried
them. No generation counters, and optimistic state is never dropped ahead of
the synced store.

Request frequency becomes `min(update rate, 1/RTT)`. Eight `collection.update()`
calls per second stay roughly eight requests at 40 ms RTT and fall to about
five at 200 ms, adapting without a tuned constant. The optimistic UI is
unaffected: the local row updates on every `update()` call; only the network is
coalesced.

Boundaries of the mechanism:

- Only `update` coalesces. Inserts and deletes are not high-frequency and
  merging their semantics is ambiguous.
- `onDelete` for a key with a non-empty queue discards the accumulated changes
  and awaits the in-flight request before sending `DELETE`, so the two cannot
  race. Waiters of the discarded updates resolve — the delete supersedes them.
- A failed request rejects that batch's waiters _and_ the ones queued behind
  it, clearing the key's queue entirely. TanStack DB rolls all those
  transactions back and the row returns to its last synced value. Continuing to
  send queued changes on top of a failed base would diverge from the server
  silently, and leaving their waiters pending would hang them forever.

This is the riskiest part of the change: it alters mutation resolve timing for
every table, not just presence. Hence the isolated module and the emphasis on
queue-level tests.

### C. Error handling and drift

Dropping the per-mutation refetch also drops a blunt safety net — any
divergence from the server used to be repaired by the next mutation's `list`.
Consistency now rests on two mechanisms that already exist.

`applyRealtimeEvent` is the single write path into the synced store, for local
mutation responses and remote broadcasts alike. `writeUpsert` is idempotent, so
a client receiving the echo of its own change over the realtime channel is
harmless.

`refetchAll()` on reconnect (`realtime-sync.ts:53`) is the recovery point. A
dropped realtime event now persists until reconnect rather than until the next
mutation. That is a deliberate trade, and reconnect closes it.

One implicit contract needs a guard. `writeUpsert` writes the response whole,
so mutation endpoints must return a complete row, not a delta. bunderstack's
generated CRUD does, but applications supplying their own procedures may not:
if a response has no `id`, fall back to refetch rather than write a partial row
into the store.

### D. Testing

Unit tests for `update-queue.ts`, driven by manually resolved promises rather
than timers:

- merging: three updates during one in-flight request produce one following
  request with the combined body;
- a waiter resolves only after a request that included its changes — the
  regression guard for the flicker-back case;
- a failed request rejects that batch's waiters and clears the queue;
- `delete` awaits the in-flight request and discards queued changes.

Integration tests in the existing `collection.test.ts` style, using the fake
`procedures` object and its `calls` counter:

- one `update()` produces exactly one `PATCH` and **zero** `list` calls — the
  regression test for the original bug;
- a transaction with several mutations sends all of them, not just the first;
- `create` whose server response carries a different `id` still refetches.

## Out of scope

- Moving presence cursors onto an ephemeral broadcast channel that skips the
  database. It is the larger win for the presence case specifically, but it
  needs client-to-server realtime messaging in `bunderstack-query` and is a
  separate design.
- Changes to `examples/tldraw`. Its 120 ms cursor throttle stays; coalescing
  makes the throttle constant far less load-bearing, and whether it can be
  removed is a follow-up observation, not part of this work.
