# bunderstack-query

Typed client for [bunderstack](https://github.com/kirill-dev-pro/bunderstack)
backends: tRPC client, TanStack Query option factories, realtime
subscriptions, and React hooks.

```sh
bun add bunderstack-query
```

```ts
import { createClient } from 'bunderstack-query'
import type { App } from '../server/app'

const client = createClient<App>({ baseUrl: '/api' })
```

The root entrypoint exposes REST tables and files. If the server declares tRPC,
use the optional entrypoint to add a typed `client.trpc` namespace:

```ts
import { createTRPCClient } from 'bunderstack-query/trpc'
import type { App } from '../server/app'

const client = createTRPCClient<App>({ baseUrl: '/api' })
```

Full documentation and examples:
[github.com/kirill-dev-pro/bunderstack](https://github.com/kirill-dev-pro/bunderstack)

## Shipping TypeScript source

This package publishes raw TypeScript (`exports` point at `.ts`/`.tsx`
files). Bun consumes it natively. If a Node-based bundler or SSR server
processes it, make sure the package is bundled rather than externalized —
e.g. in Vite:

```ts
ssr: {
  noExternal: [/^bunderstack/]
}
```

Because `exports` point straight at source, your TypeScript and bundler
resolve modules *inside this package's own directory* rather than a compiled
`dist`. That makes a stray `node_modules/bunderstack-query/node_modules/`
uniquely dangerous: if one is ever present (e.g. left over from an earlier
`link:`/`file:` dependency on a local checkout, then never cleaned up after
switching to a registry version), both `tsc` and the bundler will resolve
peer packages like `@tanstack/react-query`, `@trpc/client`, or `react` from
inside it instead of your app's own `node_modules`. Two copies of a
context-carrying package like `@tanstack/query-core` means two separate
module instances at runtime — a `QueryClientProvider` from one copy is
invisible to a `useQuery` from the other, surfacing as "No QueryClient set"
or a mismatched-type error on `QueryClient`'s private fields. If you hit
either, check for nested `node_modules` under this package's install
location before assuming it's an application bug:

```sh
find node_modules -path '*/bunderstack-query/node_modules/@tanstack*'
```

A clean `rm -rf node_modules && bun install` removes any that a normal
install wouldn't have produced on its own.

## License

MIT
