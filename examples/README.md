# Bunderstack Examples

Integration examples showing how to mount `app.handler` in different frameworks.

## Prerequisites

```bash
# From repo root
bun install
```

## Quick start

Each example **auto-provisions its SQLite schema in development** when the dev server starts (`provision: 'auto'` is the default). No manual `drizzle-kit push` needed for local dev.

For production, run `db:push` explicitly before starting:

```bash
bun run db:push   # pushes all example databases
```

Or per example:

```bash
bun run --cwd examples/standalone db:push
bun run --cwd examples/tanstack-start db:push
bun run --cwd examples/nextjs db:push
bun run --cwd examples/kanban-solid-1.9 db:push
bun run --cwd examples/kanban-tanstack db:push
```

## Run examples

Use separate terminals — each binds a different port.

| Example                | Command                                   | URL                   |
| ---------------------- | ----------------------------------------- | --------------------- |
| Standalone (Bun.serve) | `bun run dev` or `bun run dev:standalone` | http://localhost:3001 |
| TanStack Start         | `bun run dev:tanstack`                    | http://localhost:3000 |
| Next.js                | `bun run dev:nextjs`                      | http://localhost:3002 |
| Kanban (Solid + Vite)  | `bun run dev:kanban`                      | http://localhost:5174 |
| Kanban (TanStack Start)| `bun run dev:kanban-tanstack`             | http://localhost:5175 |

### Standalone

```bash
bun run dev:standalone
```

API routes:

- `GET /api/health`
- `GET|POST /api/posts`
- `POST /api/files` — multipart upload (`file` field)
- `GET /api/files/:id?w=200&h=200&format=webp` — thumbnails
- `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`

### TanStack Start

Twitter-style social demo — auth, posts, follows, comments, image attachments. UI via [Oat](https://oat.ink/), data via **bunderstack-query**.

```bash
bun run dev:tanstack
bun run --cwd examples/tanstack-start seed   # once
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

| Route            | Purpose                |
| ---------------- | ---------------------- |
| `/login`         | BetterAuth             |
| `/`              | Boards in active org   |
| `/boards/:id`    | Kanban + drag-and-drop |

### Kanban (TanStack Start)

Same kanban domain on **TanStack Start + React** — polished Oat UI, `@dnd-kit`, SSR-friendly `api/$.tsx` mount (no Vite API plugin).

```bash
bun run dev:kanban-tanstack
bun run --cwd examples/kanban-tanstack seed   # once
```

Same demo accounts. Routes match the Solid example.

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
import { createBunderstackQueryClient } from 'bunderstack-query'
import type * as schema from './schema'

export const queryClient = new QueryClient()
export const api = createBunderstackQueryClient<typeof schema>({
  tables: ['posts'] as const,
  queryClient,
})

// In components:
useQuery(api.posts.listQuery({ limit: 10, offset: 0 }))
useQuery(api.posts.getQuery(postId))
useMutation(api.posts.createMutation())
```

## Environment variables

| Variable       | Default          | Description                                    |
| -------------- | ---------------- | ---------------------------------------------- |
| `DATABASE_URL` | `file:./data.db` | SQLite path (per example cwd)                  |
| `AUTH_SECRET`  | dev default      | BetterAuth secret                              |
| `NODE_ENV`     | —                | `production` disables auto schema provisioning |
