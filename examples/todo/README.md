# Todo — shareable boards, minimal full-feature example

The smallest bunderstack app that still uses **every** feature. Two routes:
your boards, and a board page whose URL doubles as the invite link.

```sh
bun install
bun run dev   # http://localhost:3005
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

## Notes

- **Schema sync**: `provision(app)` pushes the schema on boot while there is
  no `migrations/` folder. Generate migrations with drizzle-kit and commit
  them, and the same call applies them instead (no drizzle-kit at runtime).
- **Anonymous emails**: anonymous users get a generated `temp-…` address, so
  the completion email is only meaningful with the console provider (or once
  you switch to real auth).
