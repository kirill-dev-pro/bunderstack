# todo-solid-native

A Solid 2 example using Bunderstack without TanStack Query, code generation, or
a local network layer. `createClient<App>()` infers the native oRPC graph from
the server app type; the Solid adapter mirrors confirmed live-view snapshots
into a keyed store, while Solid actions own the optimistic overlay.

- `src/bunderstack.ts` — backend plus the exported `App` type handle.
- `src/native/todos.ts` — the entire app data layer: one `LiveView` and three
  optimistic actions.
- `src/TodoList.tsx` — UI and mutation-scoped error presentation.

The database generates canonical Todo IDs. `bunderstack-client` generates an
internal `operationId` for each mutation, sends it as a request header, and
waits for the matching live frame before allowing Solid to discard the
optimistic overlay. A temporary `pending:*` value is only a local render key.

Bounded views remain correct because the server emits a fresh keyed snapshot
after relevant changes when `limit` is present.

Better Auth is served by the same `app.handler` under `/api/auth/*`, but is
deliberately consumed through Better Auth's own Solid client when an app needs
authentication. It is not part of the oRPC graph.

```sh
bun run test
bun run dev
```
