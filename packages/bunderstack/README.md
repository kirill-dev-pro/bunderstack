# bunderstack

The complete backend & full-stack framework for Bun: type-safe oRPC APIs, auth, storage, realtime, jobs, email, live views, and client bindings from one single file declaration.

```sh
bun add bunderstack better-auth drizzle-orm valibot @libsql/client
```

```ts
import { createBunderstack, defineApi } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import * as v from 'valibot'
import * as schema from './schema'

export const app = await createBunderstack({
  schema,
  database: { adapter: libsql(), url: 'file:./data.db' },
  access: { posts: { crud: true } },
  realtime: true,
  api: {
    ping: defineApi({ schema })
      .public.route({ method: 'GET', path: '/api/ping' })
      .input(v.optional(v.object({})))
      .handler(() => ({ ok: true })),
  },
})

Bun.serve({ fetch: app.handler })
export type App = typeof app
```

CRUD, custom procedures, webhooks, file buckets, health, and the Publisher
event iterator form one router. Validation accepts Standard Schema; internal
generated schemas use Valibot. OpenAPI is opt-in with `openapi: true`.

Generated CRUD writes publish automatically. After a custom write commits,
publish its complete returned row with:

```ts
await context.realtime.publish(schema.posts, 'update', post)
```

Use the in-memory Publisher for one process or configure
`realtime: { redis: process.env.REDIS_URL! }` for multi-process delivery and
replay. Deployment metadata is generated with `bunx bunderstack blueprint`.

## Package Subpaths (0.21+)

- `bunderstack` — Backend runtime (`createBunderstack`, `provision`, `defineApi`, `buildApiRegistry`)
- `bunderstack/client` — Framework-neutral RPC & LiveView client (`createClient`, `createLiveView`)
- `bunderstack/client/rest` — Type-safe REST client
- `bunderstack/client/react`, `bunderstack/client/solid`, `bunderstack/client/vue`, `bunderstack/client/svelte` — LiveView UI bindings
- `bunderstack/query` & `bunderstack/query/react` — TanStack Query client (`createClient`, `syncRealtime`)
- `bunderstack/sync` — TanStack DB collections (`createSyncClient`)
- `bunderstack/start` & `bunderstack/start/auth` — TanStack Start full-stack integration
- `bunderstack/database/*` — Database adapters (`libsql`, `postgres-js`, `bun-sql`, `pglite`)
- `bunderstack/storage/*` — Storage adapters (`s3`, `disk`)
- `bunderstack/email/*` — Email adapters (`smtp`, `resend`, `console`)
- `bunderstack/jobs/*` — Job queue adapters (`memory`, `redis`)

See the [workspace documentation](https://github.com/kirill-dev-pro/bunderstack#readme) for webhooks, clients,
storage, collections, lifecycle, and complete examples.

## Upgrading

Every change is listed with before/after code in the migration guides, which live in full at:

- [Migrating to 0.21](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.21.md)
- [Migrating to 0.17](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.17.md)
- [Migrating to 0.16](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.16.md)

## License

MIT
