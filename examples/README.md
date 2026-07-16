# Bunderstack Examples

Integration examples showing how to mount `app.handler` in different frameworks.

## Prerequisites

```bash
# From repo root
bun install
```

## Quick start

Each example calls `provision(app)` on boot. With no `migrations/` folder it pushes the schema (including Bunderstack internal tables) — that's the dev loop. Once migrations are generated and committed, the same line applies them instead, without drizzle-kit:

```ts
import { provision } from 'bunderstack/provision'

export const app = createBunderstack({ schema, ... })
await provision(app)
```

**Moving to versioned migrations** — generate and commit; provision applies them from then on:

```bash
bun run db:generate   # drizzle-kit generate → migrations/
```

Or per example:

```bash
bun run --cwd examples/twitter-tanstack db:generate
bun run --cwd examples/twitter-tanstack db:migrate
```

Add `export * from 'bunderstack/schema'` to your `schema.ts` so migrations include internal tables (`bunderstack_file_meta`, `_bunderstack_idempotency`).

## Run examples

Use separate terminals — each binds a different port.

| Example                        | Command                           | URL                   |
| ------------------------------ | --------------------------------- | --------------------- |
| Twitter (TanStack Start)       | `bun run dev:twitter-tanstack`    | http://localhost:3000 |
| Todo (TanStack Start)          | `bun run dev:todo`                | http://localhost:3005 |
| Twitter (TanStack DB + shadcn) | `bun run dev:twitter-db-tanstack` | http://localhost:3003 |
| Kanban (Solid + Vite)          | `bun run dev:kanban`              | http://localhost:5174 |
| Kanban (TanStack Start)        | `bun run dev:kanban-tanstack`     | http://localhost:5175 |
| Whiteboard (TanStack Start)    | `bun run dev:tldraw`              | http://localhost:3000 |

### Standalone

```bash
bun run dev:standalone
```

API routes:

- `GET /api/health`
- `GET|POST /api/posts`
- `POST /api/files/uploads` — multipart upload (`file` field)
- `GET /api/files/uploads/:id?w=200&h=200&format=webp` — thumbnails
- `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`

### Whiteboard (TanStack Start)

Collaborative whiteboard — canvases and shapes are synced collections, images
are bucket uploads. A board URL is a share link: guests can open it, draw,
and show up in presence without an account. Live cursors and the who's-online
avatars are powered by an ordinary `presence` table (name, cursor x/y,
heartbeat timestamp) with public access rules — realtime broadcast-on-write
does the rest, no extra infrastructure.

```bash
bun run dev:tldraw
bun run --cwd examples/tldraw migrate   # once
```

| Route         | Purpose                                     |
| ------------- | ------------------------------------------- |
| `/canvas`     | Your boards (auth required)                 |
| `/canvas/:id` | The board — shareable, guest-editable, live |
| `/login`      | BetterAuth                                  |

### Twitter (TanStack Start)

Twitter-style social demo — auth, posts, follows, comments, image attachments. UI via [Oat](https://oat.ink/), data via **bunderstack-query**. Includes a tRPC `feed` procedure — posts, authors, and like counts in one call (`api.trpc.feed.queryOptions()`).

```bash
bun run dev:twitter-tanstack
bun run --cwd examples/twitter-tanstack seed   # once
```

Demo accounts (password `password123`): `alice@example.com`, `bob@example.com`, `carol@example.com`

| Route               | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `/`                 | Feed — For you / Following tabs, compose, comments |
| `/users/:id`        | Profile, follow, posts                             |
| `/profile`          | Avatar upload (auth required)                      |
| `/login`, `/signup` | BetterAuth                                         |

### Next.js

App Router catch-all at `/api/*` forwarding to `app.handler`.

```bash
bun run dev:nextjs
```

### Kanban (Solid)

Realtime kanban — orgs, boards, lists, cards, comments, activity. Solid 1.9 + Oat, SSE realtime via `bunderstack-query`.

```bash
bun run dev:kanban
bun run --cwd examples/kanban-solid-1.9 seed   # once
```

Demo accounts (password `password123`): `alice@example.com`, `bob@example.com`, `carol@example.com`

| Route         | Purpose                |
| ------------- | ---------------------- |
| `/login`      | BetterAuth             |
| `/`           | Boards in active org   |
| `/boards/:id` | Kanban + drag-and-drop |

### Kanban (TanStack Start)

Same kanban domain on **TanStack Start + React** — polished Oat UI, `@dnd-kit`, SSR-friendly `api/$.tsx` mount (no Vite API plugin).

```bash
bun run dev:kanban-tanstack
bun run --cwd examples/kanban-tanstack seed   # once
```

Same demo accounts. Routes match the Solid example.

### Todo (TanStack Start)

The minimal full-feature example — every bunderstack feature in ~10 source
files (see `examples/todo/README.md` for the tour):

- **Auto-CRUD + access**: generated `api.todos.*`, per-user `scope` resolver
- **Env validation**: `app.env.PUBLIC_APP_NAME` and `NOTIFY_COMPLETED` validated at boot
- **Email**: completing a task via tRPC sends a notification email (console in dev, SMTP in prod)
- **tRPC**: `api.trpc.stats` for counts, `api.trpc.complete` for atomic update + email
- **Storage**: image attachments with on-the-fly sharp thumbnails
- **Realtime**: SSE broadcast-on-write — open two tabs and watch them sync

```bash
bun run dev:todo
```

No signup or seed step: auth is username-only via BetterAuth's `anonymous`
plugin (only `user` + `session` tables), and the schema is pushed on boot.
Everything lives on the single `/` route.

## Tests

```bash
bun test
```

## Access control

Auto-CRUD routes are secured by default:

- BetterAuth tables are never exposed via `/api/*`
- Tables with a `userId` column get owner-scoped update/delete (public read/create)
- Other tables need explicit `access` config (see `examples/standalone/server.ts` for `authorId`)
- File uploads require authentication by default; delete is owner-only

## bunderstack-query

Typed TanStack Query options for auto-CRUD tables. See `packages/bunderstack-query` and the TanStack example feed.

```ts
import { QueryClient } from '@tanstack/react-query'
import { useQuery, useMutation } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack' // type-only: export type App = typeof app

export const queryClient = new QueryClient()
// Tables and buckets are inferred from the server app type — no tuples.
export const api = createClient<App>({ queryClient })

// In components:
useQuery(api.posts.listQuery({ limit: 10, offset: 0 }))
useQuery(api.posts.getQuery(postId))
useMutation(api.posts.createMutation())
api.files.avatars.upload(file)
```

TanStack Start apps can skip even that: `bunderstack-start`'s
`bunderstackStart<App>()` wires the QueryClient, SSR-aware fetch, and a
`bunderstack-sync` collection client in one call — see
`examples/twitter-db-tanstack/src/api.ts` and `examples/tldraw/src/api.ts`.

## Environment variables

| Variable       | Default          | Description                                                                     |
| -------------- | ---------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL` | `file:./data.db` | SQLite path (per example cwd)                                                   |
| `AUTH_SECRET`  | dev default      | BetterAuth secret                                                               |
| `NODE_ENV`     | —                | Set `production` in deploy; `provision(app)` applies committed migrations       |
