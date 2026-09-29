# Starter template for Bunderstack 1.0

Date: 2026-09-29
Branch: `next`
Release: `bunderstack@1.0.0-beta.5`
Depends on: `2026-09-29-ssr-default-design.md` (beta.4)
Hosting prerequisite: Bunderhost resource readers for Worker projects (the
Users tab is how an admin is appointed).

## Goal

A small application that shows every Bunderstack feature working, with three
real access contexts, and a navigational README on how to extend it. A new app
starts from it with `bunx bunderstack@beta create my-app`.

The references are the `djin` and `hrbreakers.com` apps: their route guards,
admin procedure, app and admin shells, and UI kit.

## Product decisions

- A small working app, not a feature gallery and not a SaaS skeleton.
- Three access contexts: a public landing, a private user area, an admin area
  only for `role = admin`.
- Personal accounts only. No organizations; the README explains how to add the
  Better Auth `organization` plugin later.
- English UI, no i18n; the README explains how to add it.
- The template has no mechanism to appoint an admin. An admin is appointed in
  Bunderhost (the Users tab). Locally the README shows how to set the role with
  `bunx drizzle-kit studio` against the dev sqld.
- Distributed with the package: `templates/starter` in the repository, copied
  into the published package at build time, like the agent skills.

## Application

TanStack Start, `render: ssr`. UI: shadcn/ui on Tailwind v4 with the `djin`
shell (sidebar, header, theme toggle), Manrope, hugeicons, light and dark
themes.

| Context | Routes | Shows |
|---|---|---|
| Public | `/`, `/login`, `/register` | Landing rendered on the server with data loaded without auth (count of public notes); sign-in and sign-up forms. |
| User area | `/app`, `/app/notes`, `/app/notes/$id`, `/app/profile` | Notes CRUD, attachments, live updates, profile with avatar. |
| Admin | `/admin`, `/admin/users`, `/admin/jobs` | Overview; users (read-only list, role shown); jobs and cron history; a button that runs the purge now. |

Features, where each one lives:

- **Auth:** email and password (Better Auth); the session is available in SSR.
- **Access:** an owner sees and changes only their notes. A note with
  `visibility: public` is readable by anyone through a public procedure.
- **Storage:** private bucket `attachments` (files on a note), public bucket
  `avatars` (profile). No image transforms: they do not run on the Workers
  runtime yet; the README lists this as a limit.
- **Job:** `attachmentUploaded` reads the uploaded file's size and type and
  stores them on the attachment row. It is idempotent, so a retry is harmless.
- **Cron:** `purgeDeleted`, daily, removes notes soft-deleted more than 7 days
  ago and their files. The admin can enqueue it now.
- **Realtime:** the notes list updates live across tabs.
- **Rate limit:** on note creation.
- **Email:** a welcome email through a job; Resend when `RESEND_API_KEY` is set,
  otherwise the message goes to the log. Shows an optional env key.

## Access contexts in code

Route guards are for UX; the server enforces access.

Backend (`src/bunderstack/`, modular):

- `schema/`: Better Auth tables with `user.role` (`'user' | 'admin'`, default
  `'user'`); `notes` (owner, title, body, visibility, deletedAt);
  `attachments` (note, file id, size, type).
- `access.ts`: `notes` and `attachments` CRUD scoped to the owner.
- `api.ts`:
  - `public.stats` on `o.public`;
  - `adminProcedure = o.protected.use(...)` that throws `errors.FORBIDDEN()`
    unless `context.user.role === 'admin'`;
  - `admin.users`, `admin.jobs`, `admin.runPurge` on `adminProcedure`.
- `user.role` is never writable from the browser: it is not in Better Auth
  `additionalFields` input.

Routes (`src/routes/`):

- root `beforeLoad`: `{ user: await fetchUser() }`;
- `app/route.tsx`: `requireUser()`, redirect to `/login?redirect=...` without a
  user;
- `admin/route.tsx`: `requireAdmin()`, redirect to `/login` without a user and
  to `/app` for a non-admin;
- public routes have no guard and read `user` (for example, "Open the app"
  instead of "Sign in").

Bunderstack addition (`bunderstack/start`): `fetchSessionUser()` reads the
session through the backend in the isolate on the server and over HTTP in the
browser. The template wraps it once:
`export const fetchUser = createServerFn().handler(() => fetchSessionUser())`.
It replaces `getSessionUser(app, request)` from 0.x, since SSR code in 1.0 has
no `app`.

## `bunderstack create`

`bunx bunderstack@beta create <directory>`:

- copies the packaged template into `<directory>`; refuses a non-empty
  directory;
- sets `package.json#name` from the directory name;
- replaces `bunderstack: workspace:*` with `^<package version>`;
- renames `_gitignore` to `.gitignore` (npm strips `.gitignore` from packages);
- keeps the committed blueprint and migrations, so Bunderhost accepts the app
  without extra steps;
- prints `cd <directory> && bun install && bun run dev`.

## README

Navigational, in this order:

1. Quick start: create, dev, sign up, become admin (local: drizzle-kit
   studio; hosted: Bunderhost Users tab).
2. Project map: backend, routes of each context, UI kit, guards.
3. Access contexts: guards and server checks, and why both.
4. Recipes, each with files to touch and how to check: a table with CRUD, a
   procedure, a page in each context, a job, a cron, a bucket, an env key, a
   realtime subscription.
5. Extensions: organizations (Better Auth plugin, access scope, an org switcher
   as in `djin`), OAuth providers, i18n (as in `djin`), another email
   provider.
6. Deploy on Bunderhost: blueprint, migrations, env, appointing an admin.
7. Runtime limits (Workers).

## CI

- `templates/*` returns to the workspaces.
- The template is in `typecheck:examples`; its `backend.test()` suite runs in
  `bun run test`: an owner-only notes check, `FORBIDDEN` on `admin.*` for a
  non-admin and data for an admin, `public.stats` for a guest, job idempotency,
  and purge age.
- `bunderstack build` of the template.
- `test:workers` gains the template: SSR landing, a guest redirected from
  `/app`, a non-admin redirected from `/admin`, note CRUD by its owner.
- A `create` test: creates into a temporary directory and checks the name, the
  version, `.gitignore`, and that the project builds.

## Out of scope

- Organizations, i18n, OAuth providers (README sections only).
- Image transforms (blocked on the WASM work in the Workers runtime spec).
- An admin-appointment mechanism inside the template.
