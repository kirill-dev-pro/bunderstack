# Kanban (TanStack Start)

A Trello-like kanban board on **TanStack Start + React**, showcasing Bunderstack **org-scoped access** and **SSE realtime**.

## What it demonstrates

- `typeid()` primary keys and denormalized `organizationId` on app rows
- BetterAuth `organization` plugin (multi-tenant boards)
- Auto-CRUD at `/api/:table` with scope enforced on every operation
- Realtime via `GET/POST /api/realtime` — broadcast-on-write with cache sync
- TanStack Start full-stack pattern: `src/routes/api/$.tsx` → `app.handler`
- `@dnd-kit` drag-and-drop, Oat UI, `@tanstack/react-query` + `bunderstack-query`

## Prerequisites

From the repo root:

```bash
bun install
```

## Setup

```bash
cp examples/kanban-tanstack/.env.example examples/kanban-tanstack/.env
bun run --cwd examples/kanban-tanstack db:push
bun run --cwd examples/kanban-tanstack seed
```

## Development

```bash
bun run dev:kanban-tanstack
```

Open http://localhost:5175

Sign in with **alice@example.com** / **password123** (seeded).

## Production

```bash
bun run --cwd examples/kanban-tanstack build
bun run --cwd examples/kanban-tanstack start
```

## Realtime flow

1. After login, the client opens `GET /api/realtime` (SSE) and receives `{ clientId }`
2. `POST /api/realtime` with `{ clientId, subscriptions: ['boards', 'lists', ...] }`
3. CRUD writes broadcast events; `bunderstack-query` invalidates TanStack Query cache

## Compared to `kanban-solid-1.9`

| | kanban-tanstack | kanban-solid-1.9 |
|---|---|---|
| Framework | TanStack Start + React | Solid 1.9 + Vite SPA |
| API mount | `routes/api/$.tsx` | Vite dev plugin + Nitro |
| Port | 5175 | 5174 |

Both showcase the same Bunderstack backend features.
