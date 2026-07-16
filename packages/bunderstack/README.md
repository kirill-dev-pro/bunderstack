# bunderstack

A batteries-included backend framework for Bun. Point it at a Drizzle schema
and get CRUD APIs, auth, file storage, realtime, typed custom endpoints
(tRPC), email, and validated env — all from a single config object and a
single `Request → Response` handler.

```sh
bun add bunderstack
```

```ts
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

const app = createBunderstack({
  schema,
  auth: { emailAndPassword: { enabled: true } },
  access: {
    posts: { ownerColumn: 'userId', list: 'public', create: 'authenticated' },
  },
})

Bun.serve({ fetch: app.handler })
```

Full documentation and examples:
[github.com/kirill-dev-pro/bunderstack](https://github.com/kirill-dev-pro/bunderstack)

## Platform deployment contract

Deployment platforms (like Bunderhost) integrate with any bunderstack app
through env vars alone — no code changes required.

### Overrides (beat code-level config)

| Var | Effect |
| --- | --- |
| `BUNDERSTACK_DATABASE_URL` | Database URL; wins over `database.url` in code |
| `BUNDERSTACK_DATABASE_AUTH_TOKEN` | Auth token for the database |
| `BUNDERSTACK_S3_ENDPOINT` | Forces ALL buckets onto this S3 backend (code-level `local`/per-bucket `s3` blocks are ignored) |
| `BUNDERSTACK_S3_BUCKET` | Physical bucket name (logical buckets become key prefixes) |
| `BUNDERSTACK_S3_ACCESS_KEY_ID` / `BUNDERSTACK_S3_SECRET_ACCESS_KEY` | Credentials |
| `BUNDERSTACK_S3_REGION` | Region (default `auto`) |
| `BUNDERSTACK_S3_PUBLIC_URL` | Public base URL for `visibility: 'public'` buckets |

Plain `DATABASE_URL` / `S3_*` vars keep their usual role: fallbacks that
code-level config wins over.

### Introspection

Set `BUNDERSTACK_INTROSPECT=1` and import the app declaration: the boot is
guaranteed offline (in-memory database, no Redis) and missing user env vars
don't throw. Then read `app.manifest`:

```ts
process.env.BUNDERSTACK_INTROSPECT = '1'
const { app } = await import('./src/bunderstack')
console.log(JSON.stringify(app.manifest))
// { dialect, tables, defaultBucket, buckets, realtime, env: { server, client } }
```

## Shipping TypeScript source

This package publishes raw TypeScript (`exports` point at `.ts` files). Bun
consumes it natively. If a Node-based bundler or SSR server processes it,
make sure the package is bundled rather than externalized — e.g. in Vite:

```ts
ssr: {
  noExternal: [/^bunderstack/]
}
```

## License

MIT
