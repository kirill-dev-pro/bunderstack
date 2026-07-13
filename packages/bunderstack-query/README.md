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

## License

MIT
