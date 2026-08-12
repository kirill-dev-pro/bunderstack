# bunderstack-sync

Optimistic TanStack DB collections backed by Bunderstack's unified oRPC graph
and Publisher realtime.

```sh
bun add bunderstack-sync @tanstack/db @tanstack/react-query
```

```ts
import { QueryClient } from '@tanstack/react-query'
import { createSyncClient } from 'bunderstack-sync'
import type { App } from '../server/bunderstack'

const queryClient = new QueryClient()
const api = createSyncClient<App>({ queryClient })

const allPosts = api.posts.collection
const feed = api.posts.scopedCollection({
  filters: { replyToId: null },
  sort: 'createdAt',
  order: 'desc',
})

await feed.loadMore()
api.realtime?.close()
```

Collections map optimistic inserts, updates, and deletes directly to generated
oRPC procedures. Every materialized view receives access-filtered row changes
from `realtime.changes`; reconnects are handled by oRPC Publisher metadata.

This package publishes TypeScript source. Node-based SSR bundlers should bundle
it instead of externalizing it; for Vite:

```ts
ssr: { noExternal: [/^bunderstack/] }
```

## License

MIT
