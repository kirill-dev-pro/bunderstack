# bunderstack

The server package for Bunderstack's unified, type-safe oRPC backend.

```sh
bun add bunderstack better-auth drizzle-orm valibot @libsql/client
```

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import * as v from 'valibot'
import * as schema from './schema'

export const app = await createBunderstack({
  schema,
  database: { adapter: libsql(), url: 'file:./data.db' },
  access: { posts: { crud: true } },
  realtime: true,
  api: (o) => ({
    ping: o.public
      .route({ method: 'GET', path: '/api/ping' })
      .input(v.optional(v.object({})))
      .handler(() => ({ ok: true })),
  }),
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

See the [workspace documentation](https://github.com/kirill-dev-pro/bunderstack#readme) for webhooks, clients,
storage, collections, lifecycle, and complete examples.

## Upgrading

0.17 is a breaking release: tRPC became oRPC, generated `list` takes nested
typed `filters`, error codes are oRPC's own, and realtime names tables by their
schema key. Every change is listed with before/after code in the migration
guides, which ship with the package as `CHANGELOG.md` and live in full at:

- [Migrating to 0.17](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.17.md)
- [Migrating to 0.16](https://github.com/kirill-dev-pro/bunderstack/blob/main/docs/MIGRATION-0.16.md)

## License

MIT
