import { useQuery } from '@tanstack/react-query'
import { createTRPCClient } from 'bunderstack-query/trpc'

import type { app } from '../bunderstack'

import { isomorphicFetch } from '../api-client'

// Type-only import of the server app: nothing server-side lands in the
// bundle, but api.trpc.* is fully typed from the router in bunderstack.ts.
const api = createTRPCClient<typeof app>({ fetch: isomorphicFetch })

/** Posts + authors + like counts in one call via the tRPC feed procedure. */
export function useFeed(limit = 20) {
  return useQuery(api.trpc.feed.queryOptions({ limit }))
}
