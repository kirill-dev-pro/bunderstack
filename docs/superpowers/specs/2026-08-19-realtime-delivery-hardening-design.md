# Realtime delivery hardening

Two changes to how realtime events reach a client: detect a stream that has died
without closing, and coalesce cache writes into one flush per frame.

Scope is `packages/bunderstack-query` (the stream loop, shared by
`bunderstack-sync`) and one field in the heartbeat payload in
`packages/bunderstack/src/realtime/`. No change to the event model: an event is
still "a row changed".

## Why

The work started as a study of [Elysia Iris](https://iris-board.millennium.sh/),
a live-query layer that ships JSON Patch over a versioned, resumable SSE stream.
Reading its client bundle against ours settled which of its ideas we already
have and which are worth taking.

Already equivalent, and not touched here:

- **Reconnect backoff.** Ours is `random() * min(cap, base * 2 ** attempt)`
  ([realtime.ts:429](../../../packages/bunderstack-query/src/realtime.ts)) —
  the same full-jitter distribution Iris uses.
- **Structural sharing.** `patchLists` replaces one row by identity and leaves
  the rest referentially equal, which is what lets a memoized list skip the
  untouched rows.
- **Mutation response as source of truth.** `bunderstack-sync` already writes
  the server's row into the synced store and declines the refetch, per
  [2026-08-11-sync-mutation-reconciliation-design.md](./2026-08-11-sync-mutation-reconciliation-design.md).
  Iris does the same thing with a bus offset echoed in a response header; ours
  arrives at the same guarantee without the offset.

What reading Iris did expose is that **our heartbeat is dead code on the
client**. The server emits one every 5 seconds
([heartbeat.ts](../../../packages/bunderstack/src/realtime/heartbeat.ts)) and
the client discards it:

```ts
if (isRealtimeHeartbeat(event)) continue
```

Nothing arms a timer on it. A connection that dies without a clean close — a
proxy idle-timeout, a laptop sleeping, a NAT rebind, a phone moving from wifi to
cellular — leaves `for await` suspended forever. It never resolves and never
throws, so the retry loop below it never runs. The client believes it is live,
receives nothing, and stays that way until someone reloads the page. Iris uses
exactly this signal: the server advertises `keepalive: 8000` in its opening
frame and the client cancels the read after 2.5x that.

That is a correctness hole, and it is the reason this work is scoped ahead of
any protocol change.

The second item is cost, not correctness. `apply()` writes the cache once per
event, so a burst of fifty changes is fifty `invalidateQueries` calls in the
default mode.

## Decisions

| Decision               | Choice                                          | Reason                                                                                                              |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Liveness source        | Server advertises its interval on the heartbeat | The client derives its timeout instead of hardcoding a constant that drifts from the server's.                      |
| Protocol compatibility | One optional field, additive both directions    | New client + old server falls back to 5s; old client + new server ignores it. No coordinated deploy.                |
| Default scheduler      | `'frame'`, with `'sync'` as escape hatch        | The synchronous cache write was never a documented contract, and apps relying on it are already racing the network. |
| Row-level dedupe       | Not done                                        | Muddies the `onChange` contract for a marginal win once the flush and the invalidation collapse are in place.       |
| Structure              | Extract the stream lifecycle before changing it | A dead-stream timer is testable with a fake clock only if it is not tangled with the TanStack cache writes.         |
| Versioned live queries | Out of scope                                    | Reshapes the framework contract. Nothing here forecloses it.                                                        |

## Module layout

`realtime.ts` is 439 lines holding types, query-key helpers, filter and sort
matching, list patching, and the connection loop. Adding a liveness timer and a
flush scheduler to it makes a file that is already doing too much worse. The
precedent for splitting is `bunderstack-sync`'s `update-queue.ts`, extracted as
"pure logic, no TanStack dependency, unit-testable on its own" for the same
reason: a risky timing change wants to be tested without the network.

| File                         | Owns                                      | Imports TanStack |
| ---------------------------- | ----------------------------------------- | ---------------- |
| `realtime-stream.ts` _(new)_ | Connect, liveness, backoff, `lastEventId` | No               |
| `realtime-flush.ts` _(new)_  | Pacing: `'sync'` \| `'frame'` \| number   | No               |
| `realtime.ts` _(shrinks)_    | What an event does to the cache           | Yes              |

Both new modules accept an injectable clock (`setTimeout`, `clearTimeout`) so
tests drive time directly.

**Type ownership.** `realtime.ts` will import `realtime-stream.ts`, so the
event types cannot keep living in `realtime.ts` without a cycle.
`RealtimeAction`, `RealtimeChange`, `RealtimeHeartbeat`, `RealtimeEvent`,
`RealtimeProcedure` and `RealtimeSyncHandle` move to `realtime-stream.ts`;
`realtime.ts` re-exports them. `index.ts` keeps exporting the same names from
`./realtime` and the package's public API is byte-identical.

`realtime-stream.ts` stays concrete to `RealtimeEvent` rather than generic over
an event type. It has one caller in the same package; a type parameter plus
predicate callbacks for "is this a heartbeat" and "what is this event's id"
would be indirection for nobody.

```ts
export type RealtimeStreamOptions = {
  subscribe: (opts: {
    signal: AbortSignal
    lastEventId?: string
  }) => Promise<AsyncIterable<RealtimeEvent>>
  onChange: (change: RealtimeChange) => void
  onReconnect: () => void | Promise<void>
  onError?: (error: unknown) => void
  onRetry?: (retry: { attempt: number; delayMs: number }) => void
  signal: AbortSignal
  retryMs?: number
  maxRetryMs?: number
  livenessFactor?: number
  defaultKeepaliveMs?: number
  clock?: RealtimeClock
}

export function openRealtimeStream(
  options: RealtimeStreamOptions,
): RealtimeSyncHandle
```

## Dead-stream detection

The heartbeat carries the interval that produced it:

```ts
export type RealtimeHeartbeat = { type: 'heartbeat'; intervalMs?: number }
```

`withRealtimeHeartbeat` already resolves its own `intervalMs`; it emits that
value in the payload. The field is optional so a client meeting an older server
falls back to `defaultKeepaliveMs`, and an older client meeting a newer server
ignores a field it does not read. That fallback is 5000 — its own constant in
`bunderstack-query`, chosen to mirror `REALTIME_HEARTBEAT_INTERVAL_MS`, not
imported from it. The client package does not depend on the server package, and
the two are free to drift precisely because the server now advertises its real
interval. Heartbeats remain unpublished, unpersisted,
and without event IDs, so replay and resume semantics are unchanged.

The client sets its timeout to `intervalMs * livenessFactor`, default 2.5 —
12.5 seconds against the 5-second default. The factor tolerates one lost
heartbeat plus scheduling slack without tolerating two.

The timer arms when `subscribe()` resolves, not on the first event. A server
that accepts the connection and then goes silent is the same failure as one that
goes silent later, and waiting for a first event to start the clock would miss
it. Every subsequent event re-arms the timer, heartbeats included — that is the
entire point of receiving them.

On expiry the stream aborts a per-attempt `AbortController`, composed with the
caller's signal through `AbortSignal.any`, the idiom already used for the outer
signal. The iterator throws, the existing catch runs, backoff applies, and the
reconnect path calls `invalidateAll()` as it does for any other reconnect.

`retryAttempt` continues to reset on every received event. A liveness-triggered
reconnect that succeeds and receives a heartbeat has a healthy connection, and
its backoff should start over.

**Consequence to expect:** a tab backgrounded long enough for timer throttling
to bite will fire the liveness timer late, reconnect, and refetch on wake.
That is intended, and better than the current silent staleness, but it does mean
waking a laptop now produces a reconnect where it previously produced nothing.

## Coalescing

`apply()` stops writing the cache. It appends to a buffer and asks the scheduler
to flush. The buffer holds changes in arrival order and a `Set` of table names
needing invalidation.

The flush runs inside `notifyManager.batch()` so the resulting listener
notifications fire once. It is a single pass over the buffer followed by one
invalidation pass:

```
for each buffered change, in arrival order:
    onChange?.(change)
    detail-key write            // setQueryData, or removeQueries on delete
    if strategy is 'patch':
        patchLists(change)      // unpatchable lists add their table to the set
    else:
        add change.table to the set

for each table in the set:
    invalidateQueries({ queryKey: tableQueryKey(table) })
```

The final pass is the larger win. Fifty changes to one table currently issue
fifty `invalidateQueries` calls, and `'invalidate'` is the default strategy; the
render batching in the first pass matters mainly in `'patch'` mode.

Note that `patchLists` today calls `invalidateQueries` inline when a list cannot
absorb a change. Redirecting those calls into the set is part of this change,
not a separate one — it is where most collapsed invalidations in `'patch'` mode
come from.

`onChange` fires for every event, in arrival order, at flush time. Nothing is
dropped or reordered — the only difference is a delay of up to one frame. That
is what keeps `bunderstack-sync`'s `applyRealtimeEvent` working unchanged, since
`createSyncRealtimeClient` delegates entirely to `syncRealtime` and reaches the
cache through this callback.

Row-level dedupe — collapsing repeated changes to the same `(table, id)` to
last-wins — is deliberately not done. It would require deciding whether
`onChange` reports one event or five, and once the flush is batched and the
invalidations are collapsed, the remaining `setQueryData` calls are cheap.

A new option threads the mode through:

```ts
notifyScheduler?: 'sync' | 'frame' | number  // default 'frame'
```

`'frame'` uses `requestAnimationFrame` where available and `setTimeout(fn, 0)`
otherwise, which covers SSR and tests. A number is a millisecond debounce.

`close()` flushes pending work synchronously so nothing in the buffer is lost.
A reconnect discards the buffer, since `invalidateAll()` supersedes it.

## Error handling

**Liveness aborts are not errors.** The abort carries a named reason, and
`onError` does not fire for it. A proxy closing an idle connection is expected
operation; reporting it to application error handlers would be noise. `onRetry`
still fires, so a caller that wants to surface reconnection can.

**A throwing `onChange` no longer kills the stream.** Today it propagates out of
`apply` and terminates the `for await` loop. Each callback invocation moves
inside a try/catch that reports through `onError` and continues. This is an
existing latent bug that the extraction makes natural to fix, not new scope.

**Repeated reconnect failure** is unchanged: backoff grows to `maxRetryMs` and
stays there until the caller closes the handle.

## Testing

`realtime-stream.test.ts`, with a fake clock and a fake async iterable:

- silence past the liveness window aborts the attempt and reconnects
- a heartbeat re-arms the timer and prevents the abort
- a server-advertised `intervalMs` overrides the default
- an absent `intervalMs` falls back to 5000
- a liveness abort does not call `onError`, and does call `onRetry`
- `lastEventId` is carried across a reconnect
- backoff delays follow the jittered sequence
- closing the outer signal ends the loop without an error

`realtime-flush.test.ts`:

- `'sync'` runs the flush inline
- `'frame'` coalesces N schedules into one flush
- a numeric mode debounces by that many milliseconds
- dispose cancels a pending flush

`realtime.test.ts` additions:

- fifty changes to one table produce exactly one `invalidateQueries`
- `onChange` observes all fifty, in arrival order
- `close()` flushes buffered work

## Out of scope

**The access filter.** `filterRealtimeChanges` awaits the async `checkAccess`
for every change on every connection, and `checkAccessSync`
([access.ts:407](../../../packages/bunderstack/src/access.ts)) already resolves
the four non-function rules without a promise. Switching to it was considered
and dropped: the policies are all O(1), so the only saving is promise and
microtask churn, and no measurement of a real workload says that is worth a
change to the authorization path. If delivery cost is ever profiled and the
filter shows up, this is the first thing to try.

Server-side frame batching, a protocol-aware connection budget, and versioned
live queries with JSON Patch. Those belong to a separate design that would
change what an event _is_; nothing here forecloses it.
