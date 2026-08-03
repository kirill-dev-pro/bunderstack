# Minimal full-feature todo example — design

Date: 2026-07-13
Status: approved

## Goal

Make `examples/todo` the smallest possible example that still demonstrates
every bunderstack feature: auto-CRUD + access rules, env validation, email,
tRPC, file storage (with sharp transforms), and realtime SSE.

## Auth: anonymous sessions instead of email+password

Bunderstack's access rules (`'authenticated'`, `'owner'`) and
`protectedProcedure` resolve users through the BetterAuth session, so
BetterAuth stays. We use its `anonymous` plugin:

- Server: `plugins: [anonymous()]`, no `emailAndPassword`.
- Client: `better-auth/react` (fixes the existing `better-auth/vue` bug)
  plus `anonymousClient()`.
- Flow: logged-out index shows a single "Pick a username" input →
  `signIn.anonymous()` → `updateUser({ name })`.
- Delete `login.tsx` and `signup.tsx`.

## Schema (~85 → ~45 lines)

- Keep `user` (add `isAnonymous` boolean required by the plugin) and
  `session`. Delete `account` and `verification` — only touched by
  credential/OAuth/email-verification flows.
- `todos` gains nullable `imageFileId: text` for the storage feature.

Verified in the browser: anonymous sign-in, CRUD, image upload + sharp
thumbnails, realtime two-tab sync, and completion email all work without
the deleted tables.

Implementation notes discovered during the build:

- Queries must live in a component that only mounts when authenticated,
  otherwise they 401 on the login screen and cache the error.
- Auto-CRUD mutations invalidate only their own table keys; the tRPC stats
  query gets a manual `onSuccess: invalidateStats` on each mutation.

## Features shown

1. **Auto-CRUD + access** — `access.ts` shrinks to `todos` rules; auth
   tables are auto-excluded from CRUD, so no entries needed (no public user
   exposure — it would leak anonymous temp emails). Note: `list: 'owner'`
   is not a thing (no row to check) — per-user lists use
   `list: 'authenticated'` plus a `scope` resolver, which also filters
   realtime events.
2. **Env validation** — keep `NOTIFY_COMPLETED` (server) and
   `PUBLIC_APP_NAME` (client) as-is.
3. **Email** — keep the tRPC `complete` mutation (update + notification
   email in one call; console provider in dev).
4. **tRPC** — keep `stats` + `complete`.
5. **Storage** (new) — `storage: { local: true, defaultBucket: 'images',
buckets: { images: { upload: { maxSize: '5mb', accept: ['image/*'] },
transforms: true } } }` (`defaultBucket` must name a declared bucket).
   Optional file input in the create form → `api.files.images.upload(file)`
   → `imageFileId` on the todo → `?w=64&format=webp` thumbnail in the row.
6. **Realtime** (new) — `createRealtimeClient({ baseUrl: '/api',
queryClient, tables: ['todos'] })` wired in `router.tsx`; two open tabs
   stay in sync.

## Deletions

- `scripts/seed.ts`, `scripts/migrate.ts`, `drizzle.config.ts`, and the
  db/seed package scripts — `app.provision()` pushes schema in dev; README
  points at drizzle-kit for production migrations.
- The "feature callouts" JSX box → README section.
- Inline styles → one small `styles.css`.

## Result

~10 source files instead of 17, schema halved, one route instead of three,
six features demonstrated instead of four.
