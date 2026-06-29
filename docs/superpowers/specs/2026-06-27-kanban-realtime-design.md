# Kanban example + realtime & access-scope core features

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan

## Goal

Ship a Trello-like kanban example (`examples/kanban`) that is a real showcase for
bunderstack, and — driven by that example's real-world needs — add two reusable
features to the **core library**:

1. **Realtime collections** — PocketBase-style SSE broadcast-on-write.
2. **Access `scope`** — declarative multi-tenant / row-scoping that secures both
   REST list/get and realtime per-event delivery.

The example itself stays minimal; the framework features are the substantive work.

## Stack

- **Backend:** bunderstack (Bun.serve standalone handler), libSQL/SQLite, Drizzle,
  BetterAuth **with the `organization` plugin** (orgs, members, invitations).
- **Frontend:** SPA — **Vite + Solid 2 (beta)**, [Oat](https://oat.ink/) for UI,
  `@tanstack/solid-query` for data, `@thisbeyond/solid-dnd` for drag-and-drop.
- **IDs:** the new `typeid()` column for all app tables (`board_…`, `list_…`,
  `card_…`, `cmt_…`, `act_…`). Org/member/invitation ids come from BetterAuth.

---

## Part 1 — Core feature: Access `scope`

### Problem

bunderstack access rules (`public|authenticated|owner|deny|fn`) can allow/deny an
operation, but `list` has no row and bunderstack does not inject access-based
`WHERE` clauses. A `list: authenticated` rule on a multi-tenant table returns rows
from **every** org. We need tenant scoping that is also reusable for realtime.

### Design — scope as an equality map

A table's access config gains an optional `scope` resolver returning a small
equality/membership map:

```ts
scope: (ctx) => ({ organizationId: ctx.session.activeOrganizationId })
//   ownership equivalent:        ({ userId: ctx.user.id })
//   multi-value (→ SQL IN):      ({ organizationId: ctx.session.orgIds })
```

From this **one declaration** bunderstack:

- **`list`** → AND `column = value` (or `IN (...)`) onto the query.
- **`get` / `update` / `delete`** → assert the loaded row matches the map (else 404/403).
- **realtime** → assert the event row matches the map before delivery.

### Why an equality map (and not arbitrary predicates)

An equality map is the one shape that evaluates **identically as SQL** (for `list`)
**and as a pure in-memory check** (for `get` + realtime). That guarantees:

1. **REST and realtime auth cannot drift** — an event is delivered iff the row
   would be readable over REST.
2. **Realtime stays cheap** — per-event authorization is a property comparison on
   the payload, **zero DB round-trips**.

Arbitrary Drizzle conditions (RLS/PostgREST-style) are rejected for v1: Drizzle has
no in-memory evaluator, so realtime would re-query the DB per event × subscriber
(the cost PocketBase pays) and risk REST/realtime divergence.

### Changes

- `AccessContext` gains `session: { activeOrganizationId?: string; ... }`, populated
  from the BetterAuth session (already tracked by the org plugin). `resolveAccessUser`
  is extended to return it.
- `TableAccessInput` / `ResolvedTableAccess` gain `scope?: (ctx) => Record<string, string | string[]>`.
- `list-query.ts` ANDs the scope filter into the list query.
- `crud.ts` get/update/delete assert the row satisfies the scope map.
- A shared `rowMatchesScope(row, scopeMap)` helper, reused by realtime.
- `owner` remains as-is for back-compat (it is conceptually `scope: { [ownerColumn]: user.id }`).

### Multi-tenant denormalization (example convention)

To keep scope a pure equality check (no joins) on every level of the hierarchy,
**every app table carries `organizationId`** (boards, lists, cards, comments,
activity), in addition to its hierarchy FK (`boardId` / `listId` / `cardId`). This
is the standard tenant-denormalization pattern and keeps realtime auth trivial.

---

## Part 2 — Core feature: Realtime (PocketBase-style SSE)

### Transport & handshake

- **SSE**, served through the existing Web-standard handler (works under any mount).
- `GET /api/realtime` → opens the stream, immediately emits a `connect` event with a
  generated **`clientId`**, then periodic keepalive pings.
- `POST /api/realtime` → body `{ clientId, subscriptions: string[] }` replaces that
  connection's subscription set. Auth rides the BetterAuth session **cookie**
  automatically; the server re-resolves user + `activeOrganizationId` here.
- **Topics:** `tableName` (whole collection) and `tableName/:id` (one record).

### Broadcast-on-write

In `crud.ts`, after each successful insert / update / delete (crud.ts:204 / :271 /
:306), publish `{ table, action: 'create'|'update'|'delete', record }` to the broker.

The broker iterates connected clients and delivers to a client iff **all** hold:

1. the client is subscribed to a matching topic (`table` or `table/:record.id`), and
2. the table's `get` rule allows the client's user, and
3. `rowMatchesScope(record, scope(clientCtx))` passes (the Part-1 helper).

Payload delivered as SSE: `{ action, record }` (full row → client patches caches).

### Broker

- In-memory `Map<clientId, Client>`; `Client = { id, send, subscriptions, user, activeOrgId }`.
- Behind a tiny interface so `Bun.redis` pub/sub can replace it for multi-instance later.
- At-most-once live delivery; **no `Last-Event-ID` replay** — on reconnect the client
  refetches (solid-query invalidation). Keeps v1 minimal.

### Config

`createBunderstack({ realtime: true | { keepaliveMs?, ... } })`. Off by default.

---

## Part 3 — Core feature: realtime client in `bunderstack-query`

Framework-agnostic (no React/Solid dependency — just needs a `QueryClient`):

- `createRealtimeClient({ baseUrl, queryClient, fetch })`:
  - opens `EventSource('/api/realtime')`, captures `clientId`,
  - `subscribe(topics)` → `POST /api/realtime`,
  - on each `{ action, record }`: `setQueryData` the table's `detail(id)` key and
    `invalidateQueries` the table's `list` keys (reusing `createTableClient` key
    factories), so solid-query (or react-query) updates live.
  - reconnect handling → re-subscribe + invalidate.

Solid uses this directly with `@tanstack/solid-query`; the existing core
`createTableClient` already returns framework-neutral query-option objects.

---

## Part 4 — Example app (`examples/kanban`)

### Data model (app tables, all `typeid` + denormalized `organizationId`)

| table      | id prefix | key columns                                                                                         |
| ---------- | --------- | --------------------------------------------------------------------------------------------------- |
| `boards`   | `board`   | organizationId, title, createdAt                                                                    |
| `lists`    | `list`    | organizationId, boardId, title, position (float), createdAt                                         |
| `cards`    | `card`    | organizationId, listId, title, description (markdown text), assigneeId, position (float), createdAt |
| `comments` | `cmt`     | organizationId, cardId, authorId, body, createdAt                                                   |
| `activity` | `act`     | organizationId, boardId, cardId?, actorId, type, data (json), createdAt                             |

Plus BetterAuth tables: `user`, `session` (+`activeOrganizationId`), `account`,
`verification`, `organization`, `member`, `invitation` (org-plugin tables marked
`{ crud: false }` — managed by the plugin's own endpoints).

### Access

All app tables: `scope: (ctx) => ({ organizationId: ctx.session.activeOrganizationId })`,
`list/get/create/update/delete = authenticated` (the scope makes "authenticated"
mean "authenticated **and** in this org"). `filterable/sortableColumns` set for
`boardId`, `listId`, `cardId`, `position`.

### Ordering / drag-and-drop

- `@thisbeyond/solid-dnd`. On drop, set the moved card's `position` to the midpoint
  between its new neighbors (fractional indexing — single PATCH, no cascade).
- Moving across lists also PATCHes `listId`. Realtime broadcasts the PATCH so other
  clients see the move live.

### Rich text & comments

- Card `description`: **markdown** in a textarea with a rendered preview (small
  renderer, e.g. `marked`). Stored as plain text. No heavy WYSIWYG — keeps it minimal.
- Comments: plain text/markdown body.

### Activity / history

- Client writes an `activity` row on meaningful actions (card created, moved,
  assigned, commented). Realtime broadcast makes the activity feed live. No
  server-side hooks needed for v1.

### Server topology

- `server.ts` — `Bun.serve` mounting `app.handler` (API + auth + realtime) on a
  dedicated port.
- `vite` dev server for the Solid SPA, proxying `/api` → the API port.
- `provision: 'auto'` for dev schema; `db:push` for prod. Seed script creates an
  org, a few members, a board with lists/cards so realtime is demoable immediately.

### Routes (SPA)

| route                         | purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `/login`, `/signup`           | BetterAuth                                           |
| `/`                           | org switcher + board list (create board)             |
| `/boards/:id`                 | the board — lists, cards, drag-drop, live updates    |
| card detail (dialog/panel)    | description (markdown), assignee, comments, activity |
| org members / invite (dialog) | BetterAuth org plugin (list members, invite)         |

---

## Out of scope (v1)

- `Last-Event-ID` event replay / offline catch-up.
- Redis/multi-instance fan-out (interface left in place).
- Arbitrary-predicate (RLS) access rules.
- WYSIWYG editor, attachments/file uploads on cards, labels/due-dates, board
  permissions finer than org membership.

## Open items to verify during implementation

- BetterAuth `organization` plugin server config + its Solid/agnostic client export
  (`better-auth/solid` + `organizationClient`).
- Oat loading in a Solid SPA (browser-only import, as in the TanStack example).
- Solid 2 beta specifics per the migration guide.
