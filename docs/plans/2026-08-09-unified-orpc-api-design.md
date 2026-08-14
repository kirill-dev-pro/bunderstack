# Unified oRPC API Design

## Goal

Bunderstack exposes one application-facing API model. Generated CRUD and
custom endpoints belong to one oRPC router, share one request context, are
validated for route and handle collisions, and contribute to one OpenAPI 3.1
document. Better Auth remains responsible for executing its own endpoints but
contributes its routes and schema to the same registry and OpenAPI document.

The experiment keeps the current HTTP layout. There is no `/api/v1` prefix:

- generated CRUD stays at `/api/:table` and `/api/:table/:id`;
- Better Auth stays at `/api/auth/*`;
- files stay at `/api/files/*` and `/files/*`;
- realtime stays at `/api/realtime`;
- custom procedures declare paths beneath `/api`;
- the oRPC RPC transport is mounted at `/api/rpc/*`;
- the combined schema is served at `/api/openapi.json`.

## Developer model

`trpc:` and `routes:` are replaced by one `api:` builder. A procedure is
declared once and may be called through the typed oRPC client or through its
OpenAPI route.

```ts
const app = await createBunderstack({
  schema,
  database: { adapter: libsql() },
  access,
  api: (o) => ({
    stats: o.public
      .route({ method: 'GET', path: '/api/boards/{boardId}/stats' })
      .input(z.object({ boardId: z.number() }))
      .output(statsSchema)
      .handler(({ context, input }) => {
        return context.db.select(/* ... */)
      }),
    complete: o.protected
      .route({ method: 'POST', path: '/api/todos/{id}/complete' })
      .input(z.object({ id: z.number() }))
      .handler(/* ... */),
  }),
})
```

The client has one namespace. Generated resources and custom procedures use
the same TanStack Query utilities:

```ts
api.boards.list.queryOptions({ input: { limit: 20 } })
api.stats.queryOptions({ input: { boardId } })
api.complete.mutationOptions()
```

## API graph

The graph contains native oRPC procedures and foreign route descriptions.
Generated CRUD and custom endpoints are native. Better Auth endpoints are
foreign: their handler stays `auth.handler`, while their OpenAPI operations are
imported into the registry. Storage and realtime remain foreign during the
experiment and can be migrated after the core design is validated.

Every graph entry has a handle, HTTP method, normalized path, input/output/error
schemas, OpenAPI metadata, and an executor. Construction fails on duplicate
handles, duplicate operation IDs, duplicate method/path pairs, or ambiguous
parameterized paths.

## Context and authorization

Every native procedure receives a request-scoped context containing `req`,
response headers, `db`, `auth`, `env`, `email`, `storage`, `jobs`, and
`realtime`. Session resolution is memoized per request. `public` leaves
`user` nullable; `protected` resolves the Better Auth session and narrows
`user` and `session` to non-null values. Generated CRUD access checks use this
same context and session result.

## OpenAPI

oRPC generates the native document. Better Auth's OpenAPI plugin generates the
auth document. Bunderstack normalizes prefixes, rejects conflicts, merges paths
and components, and serves the result from `/api/openapi.json`. The experiment
must prove that a generated mobile client can call one CRUD operation and one
custom operation from that document.

## Experiment boundary

This branch is a viability experiment, not a compatibility release. It will:

1. build the shared context and `api:` authoring surface;
2. represent generated CRUD as native oRPC procedures without changing URLs;
3. mount both OpenAPI and RPC handlers;
4. import Better Auth routes into collision detection and the combined spec;
5. expose one TanStack Query client namespace;
6. migrate the Todo and Twitter custom-procedure examples.

It will not migrate storage or realtime execution, remove Hono internally, or
provide a production migration layer from tRPC.
