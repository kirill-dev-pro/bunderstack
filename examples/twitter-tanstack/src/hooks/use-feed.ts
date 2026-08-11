import { useQuery } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'

import type { app } from '../bunderstack'
import { isomorphicFetch } from '../api-client'

const api = createClient<typeof app>({ fetch: isomorphicFetch })

/** Posts + authors + like counts in one call via the feed procedure. */
export function useFeed(limit = 20) {
  return useQuery(api.feed.queryOptions({ input: { limit } }))
}
