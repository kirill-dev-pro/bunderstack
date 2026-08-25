# bunderstack-sync

Optimistic TanStack DB collections backed by Bunderstack's unified oRPC graph
and the framework-neutral realtime transport from `bunderstack-client`.

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
from `realtime.changes`; reconnect, liveness, and Publisher resume metadata are
handled by `bunderstack-client`. Realtime delivery does not pass through a
TanStack Query cache, although collections still use the supplied QueryClient
for their query-backed loading behavior.

## License

MIT
