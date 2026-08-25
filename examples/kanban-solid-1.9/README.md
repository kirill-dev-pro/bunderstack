# Kanban Example

A Trello-like kanban board showcasing Bunderstack's **org-scoped access** (`scope`) and **SSE realtime**.

## What it demonstrates

- `typeid()` primary keys on all app tables
- Denormalized `organizationId` on every app row for cheap scope checks
- BetterAuth `organization` plugin (orgs, members)
- Auto-CRUD at `/api/:table` with scope enforced on list/get/create/update/delete
- Realtime via the typed `api.realtime.changes` iterator — broadcast-on-write, per-event get-rule + scope authorization
- Solid 1.9 + Vite + Oat UI, `@tanstack/solid-query` + the unified `bunderstack/query` client

> **Note:** The plan targets Solid 2 beta; this example uses Solid 1.9 until `@thisbeyond/solid-dnd`, `@solidjs/router`, and `@tanstack/solid-query` publish Solid 2–compatible releases.

## Prerequisites

From the repo root:

```bash
bun install
```

## Development

Single process — Vite + Nitro (API at `/api/*` on the same origin):

```bash
bun run --cwd examples/kanban-solid-1.9 dev
```

Open http://localhost:5174

Production build:

```bash
bun run --cwd examples/kanban-solid-1.9 build
bun run --cwd examples/kanban-solid-1.9 start
```

## Database

Schema auto-provisions in development. For a clean slate:

```bash
bun run --cwd examples/kanban-solid-1.9 db:push
bun run --cwd examples/kanban-solid-1.9 seed
```

## Demo accounts

Password for all: `password123`

| Email             | Role in Acme org |
| ----------------- | ---------------- |
| alice@example.com | owner            |
| bob@example.com   | member           |
| carol@example.com | member           |

Seed creates org **Acme** with a **Roadmap** board (Backlog / In Progress / Done columns).

## Routes

| Route         | Purpose                      |
| ------------- | ---------------------------- |
| `/login`      | Sign in / sign up            |
| `/`           | Board list (active org)      |
| `/boards/:id` | Kanban columns + cards + DnD |

## Realtime model

1. `syncRealtime` calls `api.realtime.changes` with the subscribed table names
2. On every CRUD write, the server publishes `{ action, table, record }` to subscribers whose get-rule + scope admit the row
3. oRPC Publisher metadata carries event IDs and enables resumable reconnects

## Stretch goals (not implemented)

- Fractional midpoint ordering between cards (append-only positions used instead)
- Invitations UI (org plugin endpoints exist; members seeded directly)
