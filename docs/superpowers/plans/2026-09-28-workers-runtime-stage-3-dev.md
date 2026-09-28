# Workers runtime stage 3: `bunderstack dev`, `build`, two SPA examples

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run dev` in an app starts sqld, celld, and Vite with one
command, and `bun run build` produces `dist/client` for static assets. Two
examples, `todo-solid-native` and `agent-chat`, run this way as SPAs.

**Architecture:** A new `src/dev/` directory in the package holds the CLI side:
pinned binary downloads, `.dev.vars`, a process group with prefixed logs, the
schema push subprocess, and the `dev` and `build` commands. A small
`bunderstack/vite` plugin proxies `/api` to celld and sets the output
directory. The examples keep their backend and UI code; only the entry files
change.

**Tech Stack:** Bun (CLI only), celld 0.6.0, sqld (libsql-server) 0.24.32,
esbuild, Vite 8.

**Spec:** `docs/superpowers/specs/2026-09-27-workers-runtime-design.md`
(sections "Tooling" and "Stages").

## Global Constraints

- Work on branch `next` in `.claude/worktrees/next`. Do not push.
- Tests must not touch the machine: no network, no writes to the home
  directory, no real celld or sqld in `bun test`. Tests use temp directories
  and injected `fetch`.
- `src/dev/**` and `src/cli.ts` may use Bun APIs (build tools). `src/vite.ts`
  must not; it runs in Vite under Node or Bun.
- Pinned versions:
  - celld `v0.6.0`: `https://github.com/denoland/celld/releases/download/v0.6.0/celld-<target>.gz`
    - `aarch64-apple-darwin` sha256 `bf6f0c06c4f815eecddf61ae40340935a0dbf76be3d643bf75fdd92bfac425cd`
    - `aarch64-unknown-linux-gnu` sha256 `3d4945df3abcc6832b6e7fa978b9ee3c26e46a0b7791924843d42c0ed14eff96`
    - `x86_64-unknown-linux-gnu` sha256 `8f1e18072c234ab75459d4da104c13cebc9b29a3e4a4772086bf985829bea8aa`
  - sqld `libsql-server-v0.24.32`: `https://github.com/tursodatabase/libsql/releases/download/libsql-server-v0.24.32/libsql-server-<target>.tar.xz`
    - `aarch64-apple-darwin` `ced2a9d65a5d4b6bd72c67e98ad6c63139e2a139d91769f07fdd15be935381dd`
    - `x86_64-apple-darwin` `461480ea5a17781bab7dd5974aa804007434611baced37b6349c8060d0648e34`
    - `aarch64-unknown-linux-gnu` `37f9eee45b388a30192907ecf4565b93df945c079331657073b5b3caf8bb1cd0`
    - `x86_64-unknown-linux-gnu` `71720fc8648c19efef416efebd47145ef59b62e198770533530a858e1336879f`
- Cache: `$BUNDERSTACK_CACHE_DIR` or `~/.cache/bunderstack`, one directory per
  `<name>-<version>-<target>`. `BUNDERSTACK_CELLD_BIN` and
  `BUNDERSTACK_SQLD_BIN` select system binaries and skip the download.
- Dev state lives in `<app>/.bunderstack/dev/` (sqld data, the dev auth
  secret). celld keeps its own state in `<app>/.celld/`.
- Only `todo-solid-native` and `agent-chat` move in this stage. The other
  examples and the SaaS template stay as they are.

---

### Task 1: Pinned binaries

**Files:**
- Create: `packages/bunderstack/src/dev/binaries.ts`
- Test: `packages/bunderstack/src/dev/binaries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BinaryName = 'celld' | 'sqld'
  export type ResolveOptions = {
    env?: Record<string, string | undefined>
    cacheDir?: string
    platform?: NodeJS.Platform
    arch?: string
    fetch?: (url: string) => Promise<Response>
    log?: (message: string) => void
  }
  export function binaryTarget(platform, arch): string | undefined
  export async function resolveBinary(name: BinaryName, options?: ResolveOptions): Promise<string>
  ```

Behavior:
- `BUNDERSTACK_<NAME>_BIN` set → return it, no fetch.
- No pinned asset for the target → throw with the target and the env var
  name to set.
- Cached binary present and executable → return it, no fetch.
- Otherwise download, check sha256 of the downloaded bytes, extract into a
  staging directory, `chmod 755`, rename the staging directory into place.
  celld: `Bun.gunzipSync`. sqld: `tar -xJf` into staging, then find the file
  named `sqld` in the tree.
- A checksum mismatch throws and leaves no cache entry.

Tests use a temp `cacheDir`, a fake `fetch`, and the optional `pins` option,
which replaces the pinned table so a test can pin its own bytes:
- env override returns the path and never calls fetch;
- unsupported target throws a message that names `BUNDERSTACK_CELLD_BIN`;
- a gz asset with a matching checksum is extracted, executable, and a second
  call does not fetch;
- a checksum mismatch throws and the cache directory stays empty;
- a tar.xz asset (built in the test with `tar -cJf`) yields the `sqld` path.

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] Commit `feat(dev): pinned celld and sqld downloads`.

### Task 2: Dev env files

**Files:**
- Create: `packages/bunderstack/src/dev/env.ts`
- Test: `packages/bunderstack/src/dev/env.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function parseDotenv(text: string): Record<string, string>
  export async function readUserEnv(directory: string): Promise<Record<string, string>> // .env then .env.local
  export async function devSecret(stateDir: string): Promise<string> // creates once, then reuses
  export function devVars(input: {
    userEnv: Record<string, string>
    databaseUrl: string
    appUrl: string
    authSecret: string
  }): string
  ```

Rules for `devVars`: user values first; the dev command owns
`BUNDERSTACK_DATABASE_URL` and `APP_URL`; `AUTH_SECRET` comes from the user
when set, else the dev secret. Values with spaces, `#`, or quotes are
double-quoted with escapes.

`parseDotenv` supports `KEY=value`, `export KEY=value`, comments, blank lines,
single and double quotes, and `\n` in double quotes.

- [ ] Tests, fail, implement, pass. Commit `feat(dev): .dev.vars and the dev secret`.

### Task 3: Process group

**Files:**
- Create: `packages/bunderstack/src/dev/processes.ts`
- Test: `packages/bunderstack/src/dev/processes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProcessSpec = { name: string; cmd: string[]; cwd: string; env?: Record<string, string> }
  export class ProcessGroup {
    constructor(write?: (line: string) => void)
    start(spec: ProcessSpec): void
    /** Resolves with the name and code of the first child that exits. */
    readonly exited: Promise<{ name: string; code: number | null }>
    stop(): Promise<void> // SIGTERM, then SIGKILL after 3 s
  }
  export function prefixLines(name: string, chunk: string, pending: string): { lines: string[]; pending: string }
  ```

Each output line is written as `[name] line`, names padded to the same width,
with a stable color per name when stdout is a TTY.

Tests: `prefixLines` splits partial chunks; a group with two `bun -e`
children writes prefixed lines and `exited` names the child that exits first;
`stop()` ends a child that sleeps.

- [ ] Tests, fail, implement, pass. Commit `feat(dev): process group with prefixed logs`.

### Task 4: `bunderstack/vite`

**Files:**
- Create: `packages/bunderstack/src/vite.ts`
- Test: `packages/bunderstack/src/vite.test.ts`
- Modify: `packages/bunderstack/package.json` (export `./vite`)

**Interfaces:**
- Produces:
  ```ts
  export function bunderstack(options?: { apiPrefix?: string }): {
    name: 'bunderstack'
    config(): { build: { outDir: string }; server?: { proxy: Record<string, object> } }
  }
  ```

`config()` always sets `build.outDir` to `dist/client`. When
`process.env.BUNDERSTACK_DEV_API_URL` is set, it adds a proxy for `/api` (and
the prefix option) to that URL, with `changeOrigin: false` so auth sees the
browser origin. No import of `vite` at runtime.

- [ ] Tests, fail, implement, pass. Commit `feat(vite): bunderstack plugin for the dev proxy`.

### Task 5: `bunderstack dev` and `bunderstack build`

**Files:**
- Create: `packages/bunderstack/src/dev/push.ts` (subprocess entry)
- Create: `packages/bunderstack/src/dev/index.ts`
- Test: `packages/bunderstack/src/dev/index.test.ts`
- Modify: `packages/bunderstack/src/cli.ts`, `src/cli.test.ts`
- Modify: `packages/bunderstack/package.json` (dependency `esbuild`)
- Modify: `scripts/dependency-boundaries.test.ts` (allow `src/dev/`)

**Interfaces:**
- Consumes: Tasks 1 to 4, `runWranglerCommand` from `src/workers/wrangler.ts`.
- Produces:
  ```ts
  export type DevPlan = {
    appUrl: string
    apiUrl: string
    databaseUrl: string
    startSqld: boolean
    processes: ProcessSpec[] // celld, and vite when the app has a vite config
  }
  export function planDev(input: {
    directory: string
    userEnv: Record<string, string>
    hasVite: boolean
    ports: { app: number; api: number; db: number }
    binaries: { celld: string; sqld: string; esbuild: string }
  }): DevPlan
  export async function runDev(options: { directory: string; port?: number }): Promise<number>
  export async function runBuild(options: { directory: string }): Promise<number>
  ```

`runDev` steps:
1. `runWranglerCommand({ directory })`.
2. Read the user env. If it sets `BUNDERSTACK_DATABASE_URL`, use it and skip
   sqld. Else start sqld on a free port with data in
   `.bunderstack/dev/db` and wait for `/health`.
3. Run `bun <push.js> <directory>` with the database URL and dev secret in
   the env. `push.ts` imports the entry (`package.json#bunderstack.entry` or
   `src/bunderstack.ts`), starts the backend, resolves
   `bunderstack/provision-schema` from the app directory, runs `provision`,
   and closes. A failed push logs and dev keeps running.
4. Watch `src/` (recursive, 300 ms debounce, ignore `routeTree.gen.ts`) and
   run the push again after a change.
5. Write `.dev.vars` and start `celld dev <directory> --port <api>` with
   `CELLD_ESBUILD` set to the esbuild binary from the `esbuild` package.
6. When `vite.config.*` exists, start `bun x vite --port <app> --strictPort`
   with `BUNDERSTACK_DEV_API_URL=<api url>`. Else the app URL is the celld
   URL.
7. Print `App: <url>`. Stop all on Ctrl+C or when a child exits; exit code 0
   on Ctrl+C, 1 when a child failed.

`--port` sets the app port (default `PORT` or 5173).

`runBuild`: when a vite config exists, run `bun x vite build`; then
`runWranglerCommand({ directory, check: true })`. Exit 1 on any failure.

Tests: `planDev` with and without Vite and with a user database URL (no sqld,
URL kept); CLI parsing for `dev --port 4000` and an unknown `dev` option.

- [ ] Tests, fail, implement, pass; full `bun test` and typecheck. Commit `feat(cli): bunderstack dev and build`.

### Task 6: `todo-solid-native` as an SPA on Workers

**Files (in `examples/todo-solid-native/`):**
- `src/bunderstack.ts`: `libsql()` instead of `bunSqlite()`; export only
  `backend`, the schema, and `type App = Awaited<ReturnType<typeof backend.start>>`.
- Create `src/worker.ts` (the three lines from workers-probe).
- Create `index.html` and `src/main.tsx` (`render(() => <App />, root)`).
- Delete `src/Document.tsx`, `src/middleware.ts`, `src/provision.ts`. The
  three seed todos go away; the empty list says "Nothing yet."
- `vite.config.ts`: `solid()` without SSR or middleware, plus `bunderstack()`;
  drop nitro.
- `src/App.tsx`: import `TodoList` directly (no `clientOnly`).
- `package.json`: `dev: bunderstack dev`, `build: bunderstack build`,
  `wrangler`, remove `start` and `provision`; drop `nitro`.
- `.gitignore`: add `.bunderstack`, `.celld`, `.wrangler`, `.dev.vars`.
- Generate `wrangler.json`. README: how to run.

Check: `bun run test` in the example, `tsc --noEmit`, `bun run build`, then
`bun run dev` and use the app in the browser pane with two tabs (live update).

- [ ] Do it, check it, commit `feat(examples): todo-solid-native as an SPA on Workers`.

### Task 7: `agent-chat` as an SPA on Workers

**Files (in `examples/agent-chat/`):**
- `src/bunderstack.ts`: export `backend` and `type App`; no top-level start,
  no provision.
- `src/worker.ts`: replace `runWorker` with the `createWorker` entry.
- Delete `src/server.ts` and `src/routes/api/$.tsx`.
- `vite.config.ts`: TanStack Router plugin (`@tanstack/router-plugin/vite`)
  with `react()` and `bunderstack()`, no TanStack Start.
- Create `index.html` and `src/main.tsx` with `RouterProvider`.
- `src/routes/__root.tsx`: no `<html>` document; keep `QueryClientProvider`
  and the not-found view.
- `src/utils/session.ts`: `fetchUser` uses `authClient.getSession()`; the
  anonymous plugin returns `isAnonymous` on the user.
- Any other `createServerFn` or server import in routes moves to the API or
  the auth client.
- `src/env.ts`: default `APP_URL` stays; dev sets it.
- `package.json`: scripts as in Task 6; replace `@tanstack/react-start` with
  `@tanstack/router-plugin`.
- `.env.example`: drop `DATABASE_URL`.
- `.gitignore`, `wrangler.json`, README.

Check: tests, `tsc`, `bun run build`, `bun run dev`, and in the browser pane
send a message and see the local responder answer through a job and SSE.

- [ ] Do it, check it, commit `feat(examples): agent-chat as an SPA on Workers`.

### Task 8: Docs and changelog

- Spec: stage 3 notes (only two examples moved; `bunderstack/vite`; binary
  pins and env vars).
- Both CHANGELOGs: Added `bunderstack dev`, `bunderstack build`,
  `bunderstack/vite`.
- Root `package.json`: `typecheck:examples` keeps working for the two
  examples.
- Full `bun run test` and typecheck from the root.

- [ ] Commit `docs: stage 3 notes and changelog`.
