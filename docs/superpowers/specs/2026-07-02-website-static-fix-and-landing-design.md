# Website: Static Docs Fix, Docs Refresh, New Landing — Design

## Problem

The docs site (TanStack Start + Fumadocs, deployed to GitHub Pages) breaks on
client-side navigation: `src/routes/docs/$.tsx` wraps loader data in
`createServerFn`, so navigation/prefetch issues `GET /_serverFn/<hash>?payload=…`
— a server RPC that a static host cannot answer (404). Direct reloads work only
because prerendered pages bake the loader payload into their HTML.

## Decisions (user-approved)

- **Keep TanStack Start.** No Next.js migration — the server function is the
  only non-static piece, and it computes build-time-known data.
- **Docs content**: carry over all 10 MDX pages and update them for the new
  inferred-client APIs; add one new page for sync collections.
- **New landing page**: minimalistic, light (light-only), cloudy, hacky;
  includes an Examples section linking to the GitHub example directories.
- **Deployment contract unchanged**: static build, `GITHUB_PAGES=true` sets
  base `/bunderstack/`, `.nojekyll` postbuild.

## Part 1 — Static docs fix

- New script `website/scripts/gen-docs-manifest.ts` (wired as `predev` +
  `prebuild`): reads `content/docs/*.mdx` frontmatter + `meta.json`, builds a
  plain fumadocs `files` array, runs it through the real
  `fumadocs-core/source` `loader()` and `serializePageTree()` (same lib
  version ⇒ same shape `useFumadocsLoader` deserializes), and writes
  `website/src/lib/docs-manifest.gen.json`:
  `{ pageTree: <serialized>, paths: { "<slug-path>": "<file>.mdx" } }`.
- `src/routes/docs/$.tsx`: delete `serverLoader`/`createServerFn`; loader
  becomes pure — look up `paths[slugs.join('/')]` (empty string key for
  `/docs`), `throw notFound()` on miss, `clientLoader.preload(path)`, return
  `{ path, pageTree }`. Component unchanged.
- `/api/search` stays as-is (already `staticGET()` + prerendered).
- **Verification**: `GITHUB_PAGES=true bun run build`, serve `dist/client`
  under a local `/bunderstack/` prefix (simulating Pages), headless-browser
  test: land on `/bunderstack/`, click into docs, navigate between pages,
  hover links — assert zero 404s and zero `_serverFn` requests.

## Part 2 — Docs content refresh

- `getting-started.mdx`: server config gains `export type App = typeof app`;
  client section uses `createClient<App>()`.
- `query-client.mdx`: leads with inferred `createClient<App>` (lazy proxy,
  no tables/buckets tuples, `Object.keys(api)` empty by design); old
  `.withTables()`/`.withSchema()` builders demoted to "explicit alternatives";
  documents `MAX_LIST_LIMIT` export.
- New `sync-collections.mdx`: `createSyncClient<App>`, `collection`/`table`,
  `scopedCollection` (growing window, `loadMore`, exact `hasMore`),
  `collectionByIds` (chunked IN filter), realtime fan-out, SSR-off default.
- `framework-portability.mdx`: TanStack Start section rewritten around
  `bunderstack-start` (`bunderstackStart<App>()`, `createApiHandlers`,
  `getSessionUser`, `createStartAuthClient`) including the reserved
  `src/client.ts` filename warning.
- `api-reference.mdx`: add new exports (`createClient`, `createSyncClient`,
  `bunderstack-start` surface, `MAX_LIST_LIMIT`, `$inferClient`/`App` type).
- `meta.json`: insert `sync-collections` after `query-client`.

## Part 3 — New landing page

Replaces `src/routes/index.tsx` content entirely. Aesthetic: **minimalistic,
light, cloudy, hacky**.

- **Palette**: near-white base, ink text, one soft sky-blue accent; large
  slow-drifting blurred pastel radial blobs ("clouds") behind the hero; faint
  dot grid. Light-only (no dark variant on landing; docs keep Fumadocs theming).
- **Type**: monospace-forward (headings + accents in mono), box-drawing/ASCII
  section markers, terminal-style install line `$ bun add bunderstack` with
  copy button.
- **Sections** (single page, in order):
  1. Minimal nav: wordmark · Docs · Examples (anchor) · GitHub.
  2. Hero: one-liner ("A batteries-included backend framework for Bun"),
     install line, CTA → `/docs/getting-started`.
  3. "Declare once" two-pane code strip: server `bunderstack.ts` → fully
     inferred client (`createClient<App>()`), reflecting the real current API.
  4. Feature grid (6 terse items): CRUD from schema · Auth (BetterAuth) ·
     File storage + transforms · Realtime SSE · Access rules · Typed clients.
  5. Examples: cards for twitter-db-tanstack, tldraw, kanban-tanstack,
     kanban-solid-1.9, twitter-tanstack — each with a one-line description,
     `bun run dev:*` command, and link to
     `https://github.com/kirill-dev-pro/bunderstack/tree/main/examples/<name>`.
  6. Footer: GitHub link, MIT.
- Styling via Tailwind v4 (already set up); no new UI deps.

## Out of scope

- Search behavior changes, dark mode on landing, docs for kanban examples,
  deploy workflow changes.
