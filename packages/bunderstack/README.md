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
