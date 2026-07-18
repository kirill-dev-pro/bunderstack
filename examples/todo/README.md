# Todo — shareable boards, minimal full-feature example

The smallest bunderstack app that still uses **every** feature. Two routes:
your boards, and a board page whose URL doubles as the invite link.

```sh
bun install
bun run dev   # http://localhost:3005
bun run worker # a second terminal: processes queued jobs
```

Pick a username, create a board, and share its link — the board's typeid is
unguessable, so the URL *is* the access grant. Anyone who opens it picks a
username and collaborates: todos are visible to everyone on the board and
each one shows its author. No signup, no passwords — auth uses BetterAuth's
`anonymous` plugin, so the `account` and `verification` tables aren't needed
at all.

## Features in use

| Feature | Where | What to look at |
| --- | --- | --- |
| **Auto-CRUD + access** | [`src/access.ts`](src/access.ts) | `api.todos.listQuery({ boardId })` / `createMutation()` etc. are generated from the schema. Boards mix rules per operation: `get` is public (capability URL), `update`/`delete` are owner-only, `list` is denied so boards can't be enumerated. Todos are fully collaborative (`crud: true`, no owner column). |
| **Env validation** | [`src/bunderstack.ts`](src/bunderstack.ts) | All vars validated at boot. `app.env.PUBLIC_APP_NAME` (client-safe) and `NOTIFY_COMPLETED` (server-only) are fully typed. |
| **Email** | `trpc.complete` | The **✅ Done** button updates the DB *and* sends a notification email in one server call. Console provider in dev — watch the terminal. |
| **tRPC** | `trpc` key in `src/bunderstack.ts` | `myBoards`/`createBoard` keep board ownership server-side, `stats` aggregates per board, `complete` mixes DB + email. All inferred on the client; superjson preserves Dates. |
| **File storage** | `storage` key | The 📎 button uploads to the `images` bucket (local disk in dev, S3 in prod). Thumbnails are resized on the fly by sharp via `?w=80&format=webp`. |
| **Realtime SSE** | [`src/router.tsx`](src/router.tsx) | `createRealtimeClient` patches the query cache on every write. Open the same board in two windows — todos stay in sync as collaborators add and toggle them. |
| **Background jobs** | `jobs` key + [`src/worker.ts`](src/worker.ts) | Finishing a board's last todo (via **✅ Done**) enqueues `celebrateBoardComplete` — a retried, offloaded celebration email. Run `bun run worker` in a second terminal to process it. |
| **Cron** | `j.cron()` in [`src/bunderstack.ts`](src/bunderstack.ts) | `archiveDoneTodos` runs every minute and deletes todos done for more than 2 minutes (tuned short for the demo — a real app would use days, not minutes). In production Bunderhost invokes it by signed HTTP. |

## Notes

- **Schema sync**: `provision(app)` pushes the schema on boot while there is
  no `migrations/` folder. Generate migrations with drizzle-kit and commit
  them, and the same call applies them instead (no drizzle-kit at runtime).
- **Anonymous emails**: anonymous users get a generated `temp-…` address, so
  the completion email is only meaningful with the console provider (or once
  you switch to real auth). Same caveat applies to the board-complete
  celebration email.
- **Cron writes aren't realtime**: `archiveDoneTodos` deletes rows with a raw
  `ctx.db.delete`, which bypasses the CRUD router — only CRUD-router writes
  broadcast over realtime. Archived todos vanish on the next reload, not
  live. Any write that needs to show up instantly should go through
  auto-CRUD or a tRPC procedure that touches the same tables the client
  subscribes to.
- **Local cron**: Bunderhost owns the production clock. To see this example's
  cron locally, start the application and run
  `await app.startCronScheduler()` from a development-only entry point. Queue
  jobs and cron are deliberately separate: long scheduled work should enqueue
  a queue job instead of blocking the signed HTTP request.
