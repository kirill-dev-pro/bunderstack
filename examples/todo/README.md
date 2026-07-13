# Todo — minimal full-feature example

The smallest bunderstack app that still uses **every** feature. ~10 source
files, one route, two auth tables.

```sh
bun install
bun run dev   # http://localhost:3005
```

Pick a username and start adding todos. No signup, no passwords — auth uses
BetterAuth's `anonymous` plugin, so the `account` and `verification` tables
aren't needed at all.

## Features in use

| Feature | Where | What to look at |
| --- | --- | --- |
| **Auto-CRUD + access** | [`src/access.ts`](src/access.ts) | `api.todos.listQuery()` / `createMutation()` etc. are generated from the schema; a `scope` resolver pins lists (and realtime events) to the current user, `owner` rules guard row-level ops. |
| **Env validation** | [`src/bunderstack.ts`](src/bunderstack.ts) | All vars validated at boot. `app.env.PUBLIC_APP_NAME` (client-safe) and `NOTIFY_COMPLETED` (server-only) are fully typed. |
| **Email** | `trpc.complete` | The **✅ Done** button updates the DB *and* sends a notification email in one server call. Console provider in dev — watch the terminal. |
| **tRPC** | `trpc` key in `src/bunderstack.ts` | `api.trpc.stats.queryOptions()` and `api.trpc.complete.mutationOptions()` are inferred from the server router; superjson preserves Dates. |
| **File storage** | `storage` key | The 📎 button uploads to the `images` bucket (local disk in dev, S3 in prod). Thumbnails are resized on the fly by sharp via `?w=80&format=webp`. |
| **Realtime SSE** | [`src/router.tsx`](src/router.tsx) | `createRealtimeClient` patches the query cache on every write. Open two tabs — todos stay in sync. Events are filtered per-user by the access rules. |

## Notes

- **Schema sync**: `app.provision()` pushes the schema on boot in
  development. For production, generate real migrations with drizzle-kit.
- **Anonymous emails**: anonymous users get a generated `temp-…` address, so
  the completion email is only meaningful with the console provider (or once
  you switch to real auth).
