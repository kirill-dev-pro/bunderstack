# bunderstack-query

One typed oRPC client with TanStack Query option factories, file helpers, and
Publisher-driven realtime cache sync.

Connection lifecycle and raw event delivery come from `bunderstack-client`;
this package owns only TanStack Query keys, patching, and invalidation policy.

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

### Patching instead of refetching

Every change carries the action and the full row, so the cache can be updated
without going back to the server:

```ts
syncRealtime({ api, queryClient, tables: ['posts'], apply: 'patch' })
```

A write then costs one request instead of two. This is safe to enable
generally because it degrades rather than guesses: a list is patched only when
the answer is certain, and invalidated otherwise.

| Change   | Behaviour                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `update` | Replaced in place in every cached list; removed from lists whose filters it no longer matches, and added to those it now does |
| `delete` | Removed everywhere, with `total` decremented                                                                                  |
| `create` | Inserted at the position the list's `sort` and `order` imply                                                                  |

Membership is decidable locally because the list contract is narrow: a filter
value is `=`, an array is `IN`, and `null` is `IS NULL`, while ordering is a
single column. Two cases stay undecidable, and both fall back to invalidating
just that list:

- **`q` searches**, which need the server's `searchableColumns` to evaluate.
- **Partial pages** — anything with `hasMore`, an `offset`, or a `cursor`. An
  insert there could belong to a page you do not hold, so the boundary the
  server drew is left to the server.

`invalidate` remains the default.

### Typed changes

Pass the app type to check the table names against the schema and type every
change:

```ts
syncRealtime<App>({
  api,
  queryClient,
  tables: ['posts'],
  onChange: (change) => {
    if (change.table === 'posts') {
      change.record.title // string — the posts row, not a bag of unknowns
    }
  },
})
```

`tables` accepts only tables the app exposes, so a typo or a table with CRUD
disabled is a compile error. `onChange` receives a union discriminated by
`table`. Omitting the type parameter keeps the loose `RealtimeChange`, which is
what consumers holding only a structural client rely on.

None of this is framework-specific: `syncRealtime` takes a `QueryClient` from
`@tanstack/query-core`, so it works the same under React, Solid, Vue, or
Svelte Query.

This package publishes TypeScript source. Node-based SSR bundlers should bundle
it instead of externalizing it; for Vite:

```ts
ssr: {
  noExternal: [/^bunderstack/]
}
```

## License

MIT
