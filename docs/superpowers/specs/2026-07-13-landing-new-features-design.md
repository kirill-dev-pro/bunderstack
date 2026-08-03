# Landing page: new-feature showcase — design

Date: 2026-07-13
Status: approved

## Goal

Surface the three recently shipped features (env validation, email, tRPC)
on the website landing page, and link the new minimal todo example.

## Context

The landing's code snippets are pre-rendered by
`website/scripts/gen-code-snippets.ts` with shiki + twoslash: each snippet
is real TypeScript typechecked against the package sources, which powers
the hover-for-types trick. New feature cards therefore need new snippet
definitions there, keyed to match `BATTERIES` entries in
`website/src/routes/index.tsx`.

## Changes

1. **Three new "Batteries included" cards** (carousel grows 6 → 9):
   - `env` — `env: { server, client }` zod schemas in the config; hover
     `app.env.PUBLIC_APP_NAME` shows the inferred type.
   - `email` — `app.email.send()`; copy notes console-in-dev / SMTP-in-prod
     and BetterAuth auto-wiring.
   - `trpc` — client side: `useQuery(api.trpc.stats.queryOptions())`
     inferred from the server router, matching the corrected docs (option
     factories, not `.useQuery()` hooks).
     The shared hidden `APP_FILE` context gains a small `trpc` router (and
     env schemas) so client snippets infer `api.trpc.*`.

2. **Todo example card** first in the Examples grid — the minimal
   full-feature showcase (`bun run dev:todo`).

3. **Copy touches**:
   - Hero: "CRUD, auth, files, and realtime fall out" gains typed env,
     email, and tRPC.
   - "What you don't write" glue table: add `env.ts` (~40 lines) and
     `mailer.ts` (~60 lines) rows. The "14 lines of bunderstack.ts"
     comparison stays accurate — the visible hero snippet is unchanged.

## Out of scope

Full docs audit (only the two pending query-client/trpc edits, verified
accurate, are committed); comparison table changes; any redesign of the
landing layout.

## Verification

`bun run` the snippet generator (it hard-fails if twoslash types degrade),
then load the landing in the browser: new cards render, hovers show real
types, example card links to `examples/todo`.
