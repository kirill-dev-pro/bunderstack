# bunderstack-query

One typed oRPC client with TanStack Query option factories, file helpers, and
Publisher-driven realtime cache sync.

```sh
bun add bunderstack-query @tanstack/react-query
```

```ts
import { QueryClient } from '@tanstack/react-query'
import { createClient, syncRealtime } from 'bunderstack-query'
import type { App } from '../server/bunderstack'

export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })

await api.posts.create.call({ title: 'Hello' })
const options = api.posts.list.queryOptions({ input: { limit: 20 } })

const realtime = syncRealtime({
  api,
  queryClient,
  tables: ['posts'],
})
```

The same root contains generated CRUD, application procedures,
`realtime.changes`, and `files.<bucket>`. File buckets add `upload`, `url`, and
`delete` helpers. `syncRealtime` consumes the typed async iterator, resumes
from Publisher metadata after reconnects, and invalidates affected query
caches.

This package publishes TypeScript source. Node-based SSR bundlers should bundle
it instead of externalizing it; for Vite:

```ts
ssr: {
  noExternal: [/^bunderstack/]
}
```

## License

MIT
