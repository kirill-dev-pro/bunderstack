# Durable realtime — reliable SSE for bunderstack

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan

## Goal

Make bunderstack's realtime SSE connection **reliable**. Today, browser tabs
intermittently stop receiving card/state updates and only "catch up" when the
user interacts with the tab (TanStack Query's `refetchOnWindowFocus` papering
over the gap). The root cause is that SSE events are silently *dropped* — there
is no event replay across reconnects, the native `EventSource` reconnect stalls
on backgrounded/throttled tabs, and on reconnect the server issues a new
`clientId` with an empty subscription window during which events are lost.

This work lands **inside the `bunderstack` + `bunderstack-query` packages** — it
is not a separate package. It is framework-agnostic and can be built and verified
against the **existing React Kanban example** before any Solid work begins.

This is sub-project 1 of three (the other two — a new Solid 2.0 DnD library and a
full-parity Solid 2.0 Kanban example — get their own spec → plan → build cycles).

## Symptom → root cause

"Tab stops updating cards, resumes when I touch the tab" is the tell:

1. **No event replay.** Events broadcast while a client is disconnected (tab
   throttled, connection blip) are gone forever — no event IDs, no server buffer,
   no `Last-Event-ID` / `since` handling.
2. **Opaque native `EventSource` reconnect.** Its auto-reconnect is throttled and
   un-observable; backgrounded tabs are exactly where it stalls.
3. **Re-subscribe gap.** On reconnect the server issues a *new* `clientId`; until
   the client re-POSTs its subscriptions, the new server-side subscriber has an
   empty subscription set and receives nothing.
4. **No catch-up on reconnect.** The client only `invalidateQueries` per-event,
   so missed events are never reconciled — until `refetchOnWindowFocus` fires.

---

## Architecture — the broker stays an interface, gains durability

`RealtimeBroker` (in `packages/bunderstack/src/realtime.ts`) is the seam. We keep
it and add an event log + replay to both implementations:

- **`createMemoryRealtimeBroker`** (today's `createRealtimeBroker`, renamed; the
  old name kept as an alias for back-compat) — in-process subscribers plus an
  in-memory **ring buffer** of recent events.
- **`createRedisRealtimeBroker`** (new) — uses `Bun.redis`: `PUBLISH`/`SUBSCRIBE`
  for cross-instance fan-out, a capped stream (`XADD … MAXLEN`) as the replay
  buffer, and `INCR` for a globally monotonic event id.

`createBunderstack` (`index.ts:193`) selects the broker: if `realtime.redis` (or
`process.env.REDIS_URL`) is set → Redis broker; otherwise → memory broker. No
consumer code changes; behavior is identical, just durable/multi-instance when
Redis is present.

**Correctness never depends on Redis.** Without it, a server restart drops the
in-memory buffer, which simply triggers the client's `gap`-driven full-refetch
catch-up path. Redis is a nice-to-have for persistence + horizontal scaling, the
same way `database.url` upgrades storage without changing app code.

### Redis broker fan-out (multi-instance)

- `publish(table, action, record)` → `INCR` global id → `XADD` to the capped
  buffer stream → `PUBLISH` `{eventId, table, action, record}` to the channel.
- Every instance `SUBSCRIBE`s the channel (including the publisher — Redis pub/sub
  delivers to the publisher too). The subscription callback performs the **local
  fan-out** to that instance's subscribers, applying the same access/scope/topic
  filters. This keeps a single delivery path and avoids double-delivery.

---

## Server — event IDs, ring buffer, replay protocol

- Every broadcast frame carries a **monotonic `eventId`**:
  `data: {eventId, action, table, record}`.
- The broker retains the last **N events** (default `bufferSize: 1000`,
  configurable) in the buffer.
- Replay rides the **existing two-step connect→subscribe protocol**:
  1. `GET /realtime` → stream opens, server sends `{clientId}` (as today). Keep-
     alive `: ping` frames continue unchanged (no id).
  2. Client `POST /realtime` with `{clientId, subscriptions, since: lastEventId}`.
  3. On `setContext`, the broker **replays buffered events with `id > since`** that
     pass this subscriber's access + scope + subscription filters, pushing them
     down the existing SSE stream (uniform delivery path).
  4. The POST **response returns `{gap: boolean}`** — `true` when `since` predates
     the oldest buffered event (eviction/restart) or is `null`/absent.
- Replay reuses the exact `checkAccessSync` / `scopeOk` filters already in
  `publish` — **no access-control logic is duplicated**.

### Broker interface changes

- `register(send)` unchanged.
- `setContext(id, ctx)` gains `since?: number | null` and returns `{ gap: boolean }`
  (or the router computes `gap` from a broker `replaySince(...)` helper —
  implementer's choice, but the gap signal must reach the POST response).
- `publish(...)` now also appends to the buffer and stamps `eventId`.

---

## Client — custom stream reader with full reconnect control

Replace native `EventSource` with a `fetch` + `ReadableStream` SSE reader in
`packages/bunderstack-query/src/realtime-client.ts`. The file must carry
**extensive comments** documenting: the native-`EventSource` alternative, why the
custom reader was chosen (reliability/observability of reconnect), and what we'd
lose by reverting — so the decision can be revisited after real-world testing.

It owns:

- **Reconnection** — explicit exponential backoff + jitter, capped (e.g. 1s →
  30s).
- **Heartbeat watchdog** — no bytes (event *or* `: ping`) within ~1.5×
  `keepaliveMs` → abort and reconnect immediately. Kills the "backgrounded tab
  silently stalls" failure mode.
- **`visibilitychange` hook** — tab refocus → if stale/closed, force an instant
  reconnect with reset backoff.
- **Catch-up on every (re)connect** — after receiving `clientId`, re-`POST`
  subscriptions with `since: lastEventId`; if the response says `gap: true`,
  `invalidateQueries` **all subscribed tables' lists** so the UI reconciles even
  when replay could not cover the gap.
- Tracks `lastEventId` from applied events. `refetchOnWindowFocus` stays on as the
  final safety net.

SSE parsing: accumulate the response body text, split on `\n\n`, handle `data:`
lines (JSON), ignore comment (`:`) lines but treat them as liveness for the
watchdog.

---

## Config / API surface

**Server** (`config.ts`):

```ts
realtime?: boolean | {
  keepaliveMs?: number
  bufferSize?: number              // default 1000
  redis?: string | { url: string; token?: string }  // falls back to REDIS_URL
}
```

`realtime: true` continues to work unchanged.

**Client** (`createRealtimeClient`):

```ts
createRealtimeClient({
  ...existing,                      // baseUrl, queryClient, tables, fetch
  keepaliveMs?: number,            // watchdog window; should match server
  onStatus?: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void,
})
```

Additive; existing call sites unchanged. The `EventSourceImpl` injection point is
replaced by a `fetch` injection point for testing.

---

## Testing (TDD)

- **Server**
  - monotonic event ids; `data` frames include `eventId`.
  - ring-buffer eviction at `bufferSize`.
  - replay returns only events with `id > since` that pass access/scope/topic
    filters.
  - `gap` detection: `since` older than oldest buffered → `gap: true`; covered →
    `gap: false`.
  - memory broker covered directly; Redis broker tested against the same interface
    contract (mockable `Bun.redis`, or skipped when no `REDIS_URL`).
- **Client**
  - controllable mock `fetch`/stream simulates mid-stream disconnect → assert
    reconnect + `since` re-subscribe + gap-driven invalidate.
  - watchdog fires on ping starvation → reconnect.
  - `visibilitychange` → forced reconnect.
  - happy-path apply: create/update → `setQueryData` + `invalidateQueries`;
    delete → `removeQueries`.

---

## Out of scope

- Per-subscriber durable cursors persisted across server restarts beyond the ring
  buffer (the `gap` refetch path covers this).
- Replacing `refetchOnWindowFocus` (kept as a safety net).
- Changes to the broadcast-on-write model in `crud.ts` (it keeps calling
  `broker.publish`).

## Verification target

The existing **React Kanban example** (`examples/kanban-tanstack`) is the testbed:
open two tabs, background one, mutate cards in the other, confirm the backgrounded
tab reconciles without manual interaction.
