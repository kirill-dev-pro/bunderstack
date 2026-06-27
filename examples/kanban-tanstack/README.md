# Kanban (TanStack Start)

A Trello-like kanban board on **TanStack Start + React**, showcasing Bunderstack **org-scoped access**, **file storage**, and **SSE realtime**.

## What it demonstrates

- `typeid()` primary keys and denormalized `organizationId` on app rows
- BetterAuth `organization` plugin (multi-tenant boards, invites with copyable links)
- Auto-CRUD at `/api/:table` with scope enforced on every operation
- File uploads at `POST /api/files` with image thumbnails on cards and comments
- Emoji reactions on cards and comments
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

Uploaded files are stored in `examples/kanban-tanstack/uploads/` (gitignored).

## Development

```bash
bun run dev:kanban-tanstack
```

Open http://localhost:5175

Sign in with **alice@example.com** / **password123** (seeded).

## Features

### Trello-style UI

- Colored board canvas and gradient board tiles
- Card covers from the first image attachment
- Two-column card modal (description, attachments, comments + sidebar actions)
- Comment and attachment badges on card tiles

### Workspace invites

1. Go to **Workspace** in the header (or **Share** on a board)
2. Enter an email and role, click **Send invite**
3. Click **Copy invite link** on a pending invitation
4. Share the link (`/invite/{invitationId}`) with the invitee
5. Invitee signs up or signs in, then accepts on the invite page

No email/SMTP is required — links are copied and shared manually.

### Attachments

- Add attachments from the card sidebar or when writing a comment
- Images show thumbnails; PDF and text files show as download chips
- Click an image to open the lightbox

### Reactions

- Click **+** on a card or comment to add an emoji reaction
- Click a reaction pill to toggle your reaction

## Production

```bash
bun run --cwd examples/kanban-tanstack build
bun run --cwd examples/kanban-tanstack start
```

## Realtime flow

1. After login, the client opens `GET /api/realtime` (SSE) and receives `{ clientId }`
2. `POST /api/realtime` with `{ clientId, subscriptions: ['boards', 'lists', 'cards', 'comments', 'attachments', 'reactions', 'activity'] }`
3. CRUD writes broadcast events; `bunderstack-query` invalidates TanStack Query cache

## Compared to `kanban-solid-1.9`

|           | kanban-tanstack        | kanban-solid-1.9        |
| --------- | ---------------------- | ----------------------- |
| Framework | TanStack Start + React | Solid 1.9 + Vite SPA    |
| API mount | `routes/api/$.tsx`     | Vite dev plugin + Nitro |
| Port      | 5175                   | 5174                    |

Both showcase the same Bunderstack backend features.
