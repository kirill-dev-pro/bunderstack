---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: '*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json'
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

# Bunderstack

A batteries-included backend framework for Bun. See PLAN.md for the full design.

## Core philosophy

Compose Drizzle + BetterAuth + Hono + Bun.s3 + sharp; re-export the raw
instances, never seal them. Progressive disclosure — users never hit a wall.

## Stack

Bun · Drizzle (+ drizzle-kit) · BetterAuth · Hono · libSQL · sharp

## Conventions

- Single Web-Standard `Request -> Response` handler (`app.handler`)
- Delegate migrations to drizzle-kit, never reinvent
- SSE for realtime, broadcast-on-write model

## Packages are consumed as built `dist`

`packages/*/package.json` publishes `dist/*.js` + `dist/*.d.ts`, never `src`, so
a consumer's compiler flags apply to our declarations rather than our sources.
Consequences when working in this repo:

- `bun run build` (also run by `prepare` on install and `prepack` on publish)
  compiles all four packages. Examples, the website snippets, and any app resolve
  the packages through `dist`, so a library change needs a rebuild to be visible
  outside its own package. Package tests import relative paths and do not.
- `bun run verify:consumer` packs the tarballs, installs them into a throwaway
  app with the strictest common flags and `skipLibCheck: false`, and fails if any
  diagnostic points at our packages. Run it after touching public types.
- Avoid returning types inferred from a dependency's generics from an exported
  function: declaration emit inlines those generics by name, and unbound names
  silently degrade the published type. State the type instead — see
  `createAuth` and the CRUD schema casts in `api/crud-router.ts`.

