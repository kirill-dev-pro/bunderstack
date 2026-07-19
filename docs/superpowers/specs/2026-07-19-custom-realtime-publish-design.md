# Custom Realtime Publish Design

**Date:** 2026-07-19
**Status:** approved through brainstorming

## Goal

Let custom tRPC procedures, queue jobs, cron handlers, and other server code
publish the same access-filtered realtime row events as Bunderstack's generated
CRUD routes. This closes the gap where a direct `ctx.db` write succeeds but a
`bunderstack-sync` collection remains stale until an explicit refetch.

## Core decisions

1. Bunderstack exposes one typed `RealtimeFacade<TSchema>` backed by the broker
   already selected by `createBunderstack()`.
2. The same facade is available as `app.realtime`, `ctx.realtime` in tRPC, and
   `ctx.realtime` in queue-job and cron handlers.
3. `publish()` accepts a Drizzle table object, not a raw table-name string. The
   table argument constrains the record to that table's select model and the
   implementation derives the physical table name with `getTableName()`.
4. Publishing is explicit and occurs after the application has completed its
   database write. Bunderstack does not intercept arbitrary Drizzle calls.
5. Access, read-scope, topic, replay-buffer, and Redis fan-out behavior remain
   broker responsibilities. A publisher supplies only the table, action, and
   complete returned row.
6. The facade is always present. When server realtime is disabled,
   `realtime.enabled` is `false` and `publish()` resolves without doing work,
   matching generated CRUD's current no-broker behavior.
7. `publish()` always returns `Promise<void>`, normalizing the synchronous
   memory broker and asynchronous Redis broker behind one public contract.

## Public API

```ts
import type { InferSelectModel, Table } from 'drizzle-orm'

export type RealtimeAction = 'create' | 'update' | 'delete'

type SchemaTable<TSchema extends Record<string, unknown>> = Extract<
  TSchema[keyof TSchema],
  Table
>

export interface RealtimeFacade<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly enabled: boolean

  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: RealtimeAction,
    record: InferSelectModel<TTable>,
  ): Promise<void>
}
```

`RealtimeFacade` and `RealtimeAction` are exported from `bunderstack`. The
facade factory and broker lifecycle methods remain internal; applications do
not register subscribers, select transports, or close the broker directly.

`BunderstackApp`, `TRPCContext`, and `JobContext` gain the same schema-aware
property:

```ts
type BunderstackApp<TSchema> = {
  realtime: RealtimeFacade<TSchema>
}

type TRPCContext<TSchema> = {
  realtime: RealtimeFacade<TSchema>
}

type JobContext<TSchema> = {
  realtime: RealtimeFacade<TSchema>
}
```

The facade is intentionally named `realtime` instead of adding a flat
`broadcast()` function. This matches the existing `jobs`, `email`, and
`storage` capability namespaces and leaves room for future realtime operations
without expanding every context's top level.

## Application usage

Custom tRPC mutations publish the row returned by Drizzle:

```ts
createAvatar: t.protectedProcedure
  .input(z.object({ sourceFileId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const [avatar] = await ctx.db
      .insert(schema.avatars)
      .values({
        userId: ctx.user.id,
        sourceFileId: input.sourceFileId,
        status: 'pending',
      })
      .returning()

    await ctx.realtime.publish(schema.avatars, 'create', avatar)
    await ctx.jobs.enqueue('normalizeAvatar', { avatarId: avatar.id })
    return avatar
  })
```

Jobs publish each externally meaningful state transition:

```ts
handler: async ({ avatarId }, ctx) => {
  const [running] = await ctx.db
    .update(schema.avatars)
    .set({ status: 'running' })
    .where(eq(schema.avatars.id, avatarId))
    .returning()

  await ctx.realtime.publish(schema.avatars, 'update', running)

  const output = await normalizeAvatar(running)
  const [completed] = await ctx.db
    .update(schema.avatars)
    .set({ status: 'completed', output })
    .where(eq(schema.avatars.id, avatarId))
    .returning()

  await ctx.realtime.publish(schema.avatars, 'update', completed)
}
```

Code with the application object uses the identical surface:

```ts
const [cancelled] = await app.db
  .update(schema.avatars)
  .set({ status: 'cancelled' })
  .where(eq(schema.avatars.id, avatarId))
  .returning()

await app.realtime.publish(schema.avatars, 'update', cancelled)
```

The client API does not change. Existing subscriptions receive these events
and `bunderstack-sync` applies create/update as upserts and delete as removal.

## Delivery and error semantics

Publishing means "record this best-effort row event in the configured realtime
transport," not "wait until every browser processes it." The memory broker
fans out before its call returns. The Redis broker awaits sequence allocation,
replay-log append, and pub/sub publication, but retains its existing policy of
swallowing transport failures so a realtime outage does not turn a committed
database write into an application error.

Callers should normally `await ctx.realtime.publish(...)` to preserve ordering
between successive status transitions. Generated CRUD may continue using
`void realtime.publish(...)` because its existing contract treats delivery as
fire-and-forget. Both usages are type-safe because the facade always returns a
promise.

The row must be the complete post-write row returned by `.returning()`. Passing
a partial patch is unsupported: subscriber filtering may require `id`, the
owner column, or fields referenced by `readScope`. Delete publishes the complete
pre-delete row, as generated CRUD does today.

## Access and data flow

The publish path is:

```text
custom write commits
  -> realtime.publish(Drizzle table, action, complete row)
  -> physical table name derived internally
  -> selected memory/Redis broker
  -> per-subscriber topic + get-rule + read-scope checks
  -> SSE event and replay buffer
  -> bunderstack-sync collection update
```

The publisher does not pass its current user or request. Authorization here is
about which subscribers may see the published row, and the broker already has
each subscriber's resolved user and active organization. This keeps custom and
generated writes on one filtering path and prevents application code from
accidentally bypassing access checks.

Tables absent from resolved access configuration remain non-deliverable. As in
the existing broker, function-valued `get` rules are not evaluated by realtime
v1 and therefore receive no row events.

## Transactions and ordering

Applications publish only after the write or enclosing transaction resolves:

```ts
const avatar = await ctx.db.transaction(async (tx) => {
  // Perform every related database write here.
  return committedAvatar
})

await ctx.realtime.publish(schema.avatars, 'update', avatar)
```

Publishing inside a transaction can expose a row that later rolls back and is
unsupported. For that reason this change does not add a `withBroadcast()`
wrapper: such a helper cannot know whether its callback is nested inside a
larger transaction, and it encourages one event per intermediate write in
multi-row workflows.

Successive awaited publishes preserve publisher-side order. The broker's
existing event IDs and replay behavior remain authoritative across reconnects
and Redis-backed instances.

## Existing scope-transition limitation

An update is filtered using the new row. If an update changes the owner or
read-scope fields so that a former subscriber loses access, that subscriber
does not receive the update and may retain a stale local copy. Generated CRUD
already has this limitation. Solving it requires an explicit invalidation or
before/after event design and is not part of this feature.

## Non-goals

- Automatically observing or proxying every `ctx.db` write.
- Publishing partial patches or arbitrary non-table topics.
- Adding a `withBroadcast()` database wrapper.
- Changing SSE payloads, event IDs, replay, reconnect, or Redis behavior.
- Changing realtime access-rule capabilities.
- Providing delivery acknowledgements from browser subscribers.
- Solving rows that move out of a subscriber's access scope.

## Validation

Tests cover:

- deriving the physical table name from SQLite and Postgres Drizzle tables;
- compile-time rejection of tables outside the application schema;
- compile-time rejection of records belonging to a different table;
- enabled and disabled facade behavior;
- `app.realtime`, tRPC `ctx.realtime`, queue-job `ctx.realtime`, and cron
  `ctx.realtime` all receiving the application facade;
- custom publication reaching the existing access-filtered SSE broker;
- generated CRUD continuing to publish through the same facade;
- memory and Redis broker suites remaining unchanged; and
- root package typechecking plus the complete Bunderstack test suite.
